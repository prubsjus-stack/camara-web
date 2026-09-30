# Monta el relé TURN de Cloudflare (gratis) y comprueba que funciona.
#
# Pasos:
#   1. Entra en https://dash.cloudflare.com y crea una cuenta (gratis).
#   2. Menu TURN > Create a TURN key. Anota el Key ID.
#   3. API Tokens > Create Token > plantilla "Edit Cloudflare Workers" o
#      "Read Account" con permiso TURN: Edit. Copia el token.
#   4. Ejecuta:  powershell -ExecutionPolicy Bypass -File configurar-turn.ps1
#      y pega el Key ID, el Account ID y el token cuando los pida.
#
# El script escribe un archivo .env.local con los tres valores (ignorado por
# git) y arranca el doctor para confirmar que el Allocate responde "ok".

$ErrorActionPreference = "Stop"
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  Configuracion del relé TURN de Cloudflare" -ForegroundColor Cyan
Write-Host "  -----------------------------------------" -ForegroundColor Cyan
Write-Host ""

function Pedir($etiqueta, $ayuda) {
    Write-Host "  $etiqueta" -ForegroundColor Yellow
    Write-Host "  $ayuda" -ForegroundColor DarkGray
    $valor = Read-Host "  > "
    if ([string]::IsNullOrWhiteSpace($valor)) { throw "Falto: $etiqueta" }
    return $valor.Trim()
}

$keyId    = Pedir "Key ID de la TURN key"   "Cloudflare > TURN > Create a TURN key"
$account  = Pedir "Account ID"               "Cloudflare > zona > API > Account ID"
$apiToken = Pedir "API Token"                "Cloudflare > API Tokens > Create Token (permiso TURN: Edit)"

$env:CLOUDFLARE_TURN_KEY_ID = $keyId
$env:CLOUDFLARE_ACCOUNT_ID  = $account
$env:CLOUDFLARE_API_TOKEN   = $apiToken

$archivo = Join-Path $raiz ".env.local"
@(
    "# Generado por configurar-turn.ps1. NO SUBIR A GITHUB (esta en .gitignore)."
    "CLOUDFLARE_TURN_KEY_ID=$keyId"
    "CLOUDFLARE_ACCOUNT_ID=$account"
    "CLOUDFLARE_API_TOKEN=$apiToken"
) | Set-Content -Path $archivo -Encoding UTF8

Write-Host ""
Write-Host "  Guardado en $archivo" -ForegroundColor Green
Write-Host "  Probando la conexión con el relé..." -ForegroundColor Cyan
Write-Host ""

$codigo = 0
Push-Location $raiz
try {
    python server.py --doctor
    $codigo = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($codigo -eq 0) {
    Write-Host "  TURN funcionando. Ya puedes arrancar:  python server.py" -ForegroundColor Green
} else {
    Write-Host "  El TURN no respondio. Revisa que el token tenga permiso TURN: Edit" -ForegroundColor Red
    Write-Host "  y que la cuenta tenga la TURN key activa." -ForegroundColor Red
}

Write-Host ""
