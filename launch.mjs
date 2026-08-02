#!/usr/bin/env node
// Playwright MCP を「共有Brave」に CDP 接続した状態で起動するランチャ。
//
// 旧方式はセッションごとに専用プロファイルの Brave を立てていた (スロット式)。
// その結果プロファイルが共有されず、同時起動数もスロット数 (6) で頭打ちだった。
// 現方式は brave-daemon.mjs が立てる Brave 1つに全セッションがぶら下がるので、
// ログイン状態は常に共通で、セッション数の上限も無い。
//
// 代わりに1つのブラウザを共有する副作用が出るため、このランチャが stdio を中継して
//   1. 最初の tools/call の直前に Brave を確保し、自分専用タブを開く
//      (Claude Code 起動だけではブラウザを立てない・他セッションと同じタブを掴まない)
//   2. tools/call をプロセス跨ぎで直列化する (下記 cross-talk 対策)
//   3. 終了時に自分のタブを畳む (共有ブラウザにタブを残さない)
// を行う。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBrave, pidAlive, CDP_ENDPOINT } from './brave-daemon.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.join(ROOT, 'locks', 'browser.lock');
const MAX_HOLD_MS = 120000;   // 掴んだまま固まったセッションからロックを奪うまでの時間

// Brave はここでは立てない。最初のブラウザ操作 (tools/call) が来た時に ensureBrave() する。
// 失敗時は null に戻して次の呼び出しで再試行する。
let bravePromise = null;
const braveUp = () => (bravePromise ??= ensureBrave().then(
  () => console.error(`playwright-brave: shared Brave at ${CDP_ENDPOINT}`),
  (e) => { bravePromise = null; throw e; },
));

// cdpEndpoint 指定時は userDataDir / launchOptions は無視されるので書かない
const cfgPath = path.join(ROOT, 'configs', 'cdp.json');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify({
  browser: { browserName: 'chromium', cdpEndpoint: CDP_ENDPOINT },
}, null, 2));

// Node は .cmd 直 spawn を拒否する (CVE-2024-27980) ため shell 経由。パスに空白は無い前提。
const child = spawn(`npx @playwright/mcp@0.0.68 --config ${cfgPath}`,
  { stdio: ['pipe', 'pipe', 'inherit'], shell: true, windowsHide: true });

// ---- tools/call の直列化 ----
// Playwright MCP は応答を組み立てる度に「コンテキスト内の全タブ」の page.title() を
// 呼ぶ (playwright-core lib/tools/backend/tab.js の headerSnapshot)。共有ブラウザでは
// 他セッションが遷移中のタブもここに含まれ、"Execution context was destroyed" で
// 無関係なセッションのツール呼び出しが丸ごと失敗する。上流を直せないので、
// ブラウザに触る呼び出し自体を全セッションで1つずつ通す。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeSync(fd, `${process.pid} ${Date.now()}`);
    fs.closeSync(fd);
    return true;
  } catch {
    // 保持者が死んだ / 掴みっぱなしなら奪う。読み返して競合負けを検出する。
    let pid = NaN, at = 0;
    try { [pid, at] = fs.readFileSync(LOCK, 'utf8').split(' ').map(Number); } catch {}
    const holderAlive = Number.isFinite(pid) && pidAlive(pid);
    if (holderAlive && Date.now() - at < MAX_HOLD_MS) return false;
    try {
      fs.writeFileSync(LOCK, `${process.pid} ${Date.now()}`);
      return fs.readFileSync(LOCK, 'utf8').startsWith(`${process.pid} `);
    } catch { return false; }
  }
}

function unlock() {
  try {
    if (fs.readFileSync(LOCK, 'utf8').startsWith(`${process.pid} `)) fs.unlinkSync(LOCK);
  } catch {}
}

let inflight = null;                 // 応答待ちの {id, done}
let chain = Promise.resolve();       // 自セッション内の順序も保つ

function forwardSerialized(line, id) {
  chain = chain.then(async () => {
    // Brave が立っていなければここで立てる。失敗しても呼び出しは素通しし、
    // Playwright MCP 側の CDP 接続エラーをそのままクライアントに返させる。
    try { await braveUp(); } catch (e) { console.error(`playwright-brave: Brave 起動失敗 ${e}`); }
    while (!tryLock()) await sleep(80);
    await new Promise((done) => {
      inflight = { id, done };
      child.stdin.write(line);
      // 応答が来ないまま固まっても、MAX_HOLD 経過で他セッションが奪えるので全体は止まらない
      setTimeout(() => { if (inflight?.id === id) settle(id); }, MAX_HOLD_MS);
    });
  });
}

function settle(id) {
  if (!inflight || inflight.id !== id) return;
  const { done } = inflight;
  inflight = null;
  unlock();
  done();
}

// ---- 自分専用タブの確保 ----
// Playwright MCP は接続時に「既存ページのうち最古のもの」を current tab にするため、
// 何もしないと全セッションが同じタブを掴んで goto を潰し合う (ERR_ABORTED)。
// context.newTab() は current tab を新規ページに差し替えるので、最初の tools/call の
// 直前に1度だけ注入する (initialized 時に注入すると Brave 起動を早めてしまう)。
const NEW_TAB_ID = 'launcher-newtab';
const CLOSE_TAB_ID = 'launcher-closetab';
const rpc = (id, name, args) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n';

// MCP stdio は改行区切り JSON。行はそのまま素通しし、中身は覗くだけ。
function lineFilter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i + 1));
      buf = buf.slice(i + 1);
    }
  };
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

let tabAcquired = false;

process.stdin.on('data', lineFilter((line) => {
  const msg = parse(line);
  if (msg?.method === 'tools/call' && msg.id !== undefined) {
    if (!tabAcquired) {
      tabAcquired = true;
      forwardSerialized(rpc(NEW_TAB_ID, 'browser_tabs', { action: 'new' }), NEW_TAB_ID);
    }
    forwardSerialized(line, msg.id);          // ブラウザに触る呼び出しだけロック下で通す
    return;
  }
  child.stdin.write(line);
}));
process.stdin.on('end', () => shutdown(0));

child.stdout.on('data', lineFilter((line) => {
  const msg = parse(line);
  if (msg && msg.id !== undefined) settle(msg.id);
  if (msg && (msg.id === NEW_TAB_ID || msg.id === CLOSE_TAB_ID)) {
    if (msg.error) console.error(`playwright-brave: ${msg.id} 失敗 ${JSON.stringify(msg.error)}`);
    return;                                   // 注入したリクエストの応答はクライアントに見せない
  }
  process.stdout.write(line);
}));

// ---- 終了処理 ----
// Brave は落とさない (他セッションと共有)。代わりに自分のタブだけ畳んで抜ける。
let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  if (!tabAcquired) {                         // ブラウザ未使用なら畳むタブも無いので即終了
    try { child.kill(); } catch {}
    unlock();
    process.exit(code);
  }
  try { child.stdin.write(rpc(CLOSE_TAB_ID, 'browser_tabs', { action: 'close' })); } catch {}
  setTimeout(() => {
    try { child.kill(); } catch {}
    unlock();
    process.exit(code);
  }, 1500);
}

child.on('exit', (code) => { unlock(); process.exit(code ?? 0); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.on('exit', unlock);
