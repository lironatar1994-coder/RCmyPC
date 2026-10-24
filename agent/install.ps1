# Installs the Claude Remote agent: Python packages + a scheduled task that starts it
# hidden at logon (and revives it within 5 minutes if it ever stops).
#   .\install.ps1              install / update and (re)start
#   .\install.ps1 -Uninstall   stop and remove the task
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$taskName = 'Claude Remote Agent'

function Stop-Agent {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*agent.py*' -and $_.CommandLine -like "*$here*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-Agent
    Write-Host 'Agent removed.'
    return
}

if (-not (Test-Path "$here\config.json")) { throw 'config.json is missing - run ..\deploy.ps1 first.' }
$python = (Get-Command python -ErrorAction Stop).Source
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { throw "pythonw.exe not found next to $python" }

& $python -m pip install --quiet --disable-pip-version-check -r "$here\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$here\agent.py`"" -WorkingDirectory $here
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $watchdog) -Settings $settings -Principal $principal -Force | Out-Null

Stop-Agent
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$running = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like "*$here*agent.py*" }
if ($running) { Write-Host "Agent running (pid $($running.ProcessId)). Log: $here\agent.log" -ForegroundColor Green }
else { Write-Warning "Agent did not start - see $here\agent.log" }
