#!/usr/bin/env node
// Playwright MCP を「空いている Brave プロファイルスロット」で起動するランチャ。
// 各 Claude セッションが自分専用の Brave を立ち上げ、セッション終了時に閉じてスロットを返す。
// スロット1 = brave-claude-profile(従来)、2〜3 = ログイン済みクローン、4〜6 = 空プロファイル(予備)。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_SLOTS = 6;
const LOCK_DIR = path.join(ROOT, 'locks');
const CFG_DIR = path.join(ROOT, 'configs');

fs.mkdirSync(LOCK_DIR, { recursive: true });
fs.mkdirSync(CFG_DIR, { recursive: true });

const slotDir = (n) =>
  path.join(ROOT, n === 1 ? 'brave-claude-profile' : `brave-claude-profile-${n}`);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// openSync('wx') がアトミックなので同時起動でも1プロセスしか取れない。
// 中身の PID が死んでいたら残骸ロックとみなして奪い、読み返しで競合負けを検出する。
function tryLock(n) {
  const file = path.join(LOCK_DIR, `slot-${n}.lock`);
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return file;
  } catch {
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch {}
    if (Number.isFinite(pid) && pidAlive(pid)) return null;
    try { fs.writeFileSync(file, String(process.pid)); } catch { return null; }
    try {
      if (fs.readFileSync(file, 'utf8') !== String(process.pid)) return null;
    } catch { return null; }
    return file;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// このスロットのプロファイルを掴んでいる brave を全部終了させる。
// "profile" が "profile-2" に前方一致マッチしないよう、パス直後は引用符/空白/終端のみ許可。
function killBrave(dir) {
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-Command',
       'Get-CimInstance Win32_Process -Filter "Name=\'brave.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true });
    if (!out.trim()) return;
    let procs = JSON.parse(out);
    if (!Array.isArray(procs)) procs = [procs];
    const re = new RegExp(escapeRe(dir) + '($|["\\s])', 'i');
    for (const p of procs) {
      if (p.CommandLine && re.test(p.CommandLine)) {
        try { process.kill(p.ProcessId); } catch {}
      }
    }
  } catch {}
}

// ---- スロット確保 ----
let lockFile = null;
let slot = 0;
for (let n = 1; n <= MAX_SLOTS && !lockFile; n++) {
  const f = tryLock(n);
  if (f) { lockFile = f; slot = n; }
}
if (!lockFile) {
  console.error(`playwright-brave: 空きスロットなし (最大 ${MAX_SLOTS} 同時起動)`);
  process.exit(1);
}

const profileDir = slotDir(slot);
killBrave(profileDir);                          // 前セッションの残骸を掃除
fs.mkdirSync(profileDir, { recursive: true });  // slot4以降は空プロファイルで開始
console.error(`playwright-brave: slot ${slot} (${path.basename(profileDir)})`);

// ---- config 生成: config.json を雛形に userDataDir と拡張だけ差し替え ----
// 拡張は extensions/ 直下の manifest.json 持ちサブフォルダを毎回列挙(sync-extensions.ps1 と同じ規則)
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const extRoot = path.join(ROOT, 'extensions');
const exts = fs.existsSync(extRoot)
  ? fs.readdirSync(extRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(extRoot, d.name, 'manifest.json')))
      .map((d) => path.join(extRoot, d.name))
  : [];
const cfg = structuredClone(template);
cfg.browser.userDataDir = profileDir;
cfg.browser.launchOptions.ignoreDefaultArgs = ['--disable-extensions'];
if (exts.length) cfg.browser.launchOptions.args = ['--load-extension=' + exts.join(',')];
else delete cfg.browser.launchOptions.args;
const cfgPath = path.join(CFG_DIR, `slot-${slot}.json`);
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// ---- MCP 本体を起動 ----
// Node は .cmd 直 spawn を拒否する (CVE-2024-27980) ため shell 経由。パスに空白は無い前提。
const child = spawn(`npx @playwright/mcp@0.0.68 --config ${cfgPath}`,
  { stdio: 'inherit', shell: true, windowsHide: true });

let done = false;
function cleanup() {
  if (done) return;
  done = true;
  killBrave(profileDir);
  try { fs.unlinkSync(lockFile); } catch {}
}

child.on('exit', (code) => {
  // MCP が自分で閉じる猶予を少し与えてから残骸を掃除
  setTimeout(() => { cleanup(); process.exit(code ?? 0); }, 1500);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(); } catch {} cleanup(); process.exit(0); });
}
process.on('exit', cleanup);
