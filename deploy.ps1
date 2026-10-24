# Deploys Claude Remote to https://lawebs.co.il/rc/ and refreshes the agent's config.
#   .\deploy.ps1                 deploy (creates the login on first run)
#   .\deploy.ps1 -NewPassword    deploy with a new random password (signs everyone out)
#   .\deploy.ps1 -Username NAME  change the login username
[CmdletBinding()]
param(
    [switch]$NewPassword,
    [string]$Username,
    [string]$SSHHost = 'root@vee-app.co.il'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed ($LASTEXITCODE)" }
}
Push-Location $PSScriptRoot
try {
    if ($SSHHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$') { throw 'Invalid SSH host' }
    $secretArgs = @('deploy/secrets.mjs')
    if ($NewPassword) { $secretArgs += '--new-password' }
    if ($Username) { $secretArgs += @('--username', $Username) }
    Invoke-Checked node $secretArgs

    $releaseId = Get-Date -Format 'yyyyMMdd-HHmmss'
    $archive = Join-Path $PSScriptRoot "dist/$releaseId.tar.gz"
    Invoke-Checked (Join-Path $env:SystemRoot 'System32\tar.exe') @('-czf', $archive, '-C', 'server', 'server.mjs', 'public')

    $base = '/opt/claude-rc'
    Invoke-Checked ssh @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', $SSHHost, "mkdir -p $base/incoming && chmod 700 $base/incoming")
    Invoke-Checked scp @('-q', $archive, 'dist/auth.json', 'deploy/deploy-linux.sh', "${SSHHost}:$base/incoming/")
    # Uploaded rather than piped: Windows PowerShell prepends a BOM to piped stdin.
    & ssh -o BatchMode=yes $SSHHost "tr -d '\r' < $base/incoming/deploy-linux.sh | bash -s -- $releaseId"
    if ($LASTEXITCODE -ne 0) { throw 'Production deployment failed' }
    Remove-Item $archive, 'dist/auth.json' -ErrorAction SilentlyContinue

    $health = Invoke-RestMethod 'https://lawebs.co.il/rc/api/health' -Headers @{ 'Cache-Control' = 'no-cache' }
    if (-not $health.ok) { throw 'Health check failed' }
    Write-Host 'Live: https://lawebs.co.il/rc/' -ForegroundColor Green
    Write-Host 'Login is in data\secrets.json. Restart the agent if the token changed: agent\install.ps1'
} finally { Pop-Location }
