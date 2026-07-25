# extensions\ 直下の「manifest.json を持つサブフォルダ」を全部 --load-extension に載せて
# config.json を更新する。拡張を追加/削除したらこれを実行 → 次の MCP セッションから反映。
# Playwright は既定で --disable-extensions を付けるため ignoreDefaultArgs で外す(必須)。
# $PSScriptRoot は実行環境によって空になるので固定パス
$root = "C:\Users\user\Desktop\_MCP\playwright-mcp-config"
$cfgPath = Join-Path $root "config.json"
$extRoot = Join-Path $root "extensions"

if (-not (Test-Path $extRoot)) { New-Item -ItemType Directory $extRoot | Out-Null }

$dirs = Get-ChildItem $extRoot -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName "manifest.json")
} | ForEach-Object { $_.FullName }

$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$lo = $cfg.browser.launchOptions

$lo | Add-Member -Force NoteProperty ignoreDefaultArgs @("--disable-extensions")
if ($dirs.Count -gt 0) {
    $lo | Add-Member -Force NoteProperty args @("--load-extension=" + ($dirs -join ","))
} else {
    $lo.PSObject.Properties.Remove("args")
}

# BOM付きで書くとMCPのJSONパースが死ぬ (PS5.1のOut-File utf8はBOM付き) → .NETでBOM無し書き込み
$json = $cfg | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("extensions: " + $dirs.Count)
$dirs | ForEach-Object { Write-Output ("  " + $_) }
