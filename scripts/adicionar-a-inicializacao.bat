@echo off
rem Coloca o painel para iniciar sozinho com o Windows (modo oculto).
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($ws.SpecialFolders('Startup') + '\Passticker.lnk'); $sc.TargetPath = 'wscript.exe'; $sc.Arguments = '\"%~dp0iniciar-oculto.vbs\"'; $sc.WorkingDirectory = '%~dp0..'; $sc.Save(); Write-Host 'Pronto: o painel vai abrir junto com o Windows.'"
pause
