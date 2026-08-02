#!/usr/bin/env node
// 全ブラウザMCPが共有する Brave を1つだけ常駐させる。
//
// Chromium は同じ user-data-dir を同時に2プロセスで開けない (SingletonLock)。
// そのため「MCPごとに自分のBraveを起動する」設計だとプロファイルを共有できず、
// 同時数もプロファイル数で頭打ちになる。ここでは逆に、ログイン済みプロファイルの
// Brave を1つだけ立ててデバッグポートを開き、各MCPは CDP でぶら下がる。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, 'brave-claude-profile');
const LOCK_FILE = path.join(ROOT, 'locks', 'daemon.lock');

export const CDP_PORT = Number(process.env.BRAVE_CDP_PORT ?? 9222);
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

// Brave の実体パスは config.json (browser.launchOptions.executablePath) を唯一の出所にする
function braveExe() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const exe = cfg?.browser?.launchOptions?.executablePath;
  if (!exe) throw new Error('config.json に browser.launchOptions.executablePath が無い');
  return exe;
}

// extensions/ 直下の manifest.json 持ちフォルダを毎回列挙 (sync-extensions.ps1 と同じ規則)
function listExtensions() {
  const extRoot = path.join(ROOT, 'extensions');
  if (!fs.existsSync(extRoot)) return [];
  return fs.readdirSync(extRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(extRoot, d.name, 'manifest.json')))
    .map((d) => path.join(extRoot, d.name));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 共有Braveが生きているか。/json/version が CDP の ws URL を返せば当たり。
async function probe() {
  try {
    const r = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return false;
    return typeof (await r.json()).webSocketDebuggerUrl === 'string';
  } catch {
    return false;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// このプロファイルを掴んでいる brave を終了させる。
// "profile" が "profile-2" に前方一致しないよう、パス直後は引用符/空白/終端のみ許可。
function killBraveHoldingProfile() {
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-Command',
       'Get-CimInstance Win32_Process -Filter "Name=\'brave.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true });
    if (!out.trim()) return;
    let procs = JSON.parse(out);
    if (!Array.isArray(procs)) procs = [procs];
    const re = new RegExp(escapeRe(PROFILE_DIR) + '($|["\\s])', 'i');
    for (const p of procs) {
      if (p.CommandLine && re.test(p.CommandLine)) {
        try { process.kill(p.ProcessId); } catch {}
      }
    }
  } catch {}
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 起動役を1プロセスに絞る。openSync('wx') はアトミックなので勝者は1人だけ。
// 中の PID が死んでいたら残骸ロックとみなして奪う。
function tryTakeLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10); } catch {}
    if (Number.isFinite(pid) && pidAlive(pid)) return false;
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid));
      return fs.readFileSync(LOCK_FILE, 'utf8') === String(process.pid);
    } catch { return false; }
  }
}

async function waitForPort(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await probe()) return true;
    await sleep(500);
  }
  return false;
}

function startBrave() {
  // ポートが応答しないのにプロファイルを掴んだ Brave が居る = デバッグポート無しの残骸。
  // 同じ dir は1プロセスしか開けないので、落としてから起動し直す。
  killBraveHoldingProfile();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,  // 既定で 127.0.0.1 のみに bind
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const exts = listExtensions();
  if (exts.length) args.push('--load-extension=' + exts.join(','));
  args.push('about:blank');
  // detached: このMCPセッションが終わっても共有Braveは残す (他セッションが使っている)
  spawn(braveExe(), args, { detached: true, stdio: 'ignore' }).unref();
}

// 共有Braveの CDP エンドポイントを返す。無ければ起動して待つ。
export async function ensureBrave() {
  if (await probe()) return CDP_ENDPOINT;
  if (tryTakeLock()) {
    try {
      startBrave();
      if (!await waitForPort(30000)) throw new Error(`Brave の CDP (${CDP_ENDPOINT}) が開かない`);
    } finally {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  } else if (!await waitForPort(30000)) {
    // 起動役が別に居る。上がるのを待つだけで、二重に Brave を立てない。
    throw new Error(`別プロセスが起動中の Brave を待ったが ${CDP_ENDPOINT} が開かない`);
  }
  return CDP_ENDPOINT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureBrave().then(
    (e) => console.log(e),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
