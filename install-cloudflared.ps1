$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "vendor\cloudflared.exe"
$url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

if (Test-Path -LiteralPath $dest) {
    Write-Host "cloudflared ya esta instalado en $dest" -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
Write-Host "Descargando cloudflared..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
Write-Host "Listo: $dest" -ForegroundColor Green
& $dest --version
