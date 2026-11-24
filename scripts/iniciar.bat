@echo off
rem Inicia o painel do Passticker com 1 duplo-clique.
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org/ e rode de novo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Primeira vez: instalando dependencias...
  call npm install --no-audit --no-fund
)
echo Abrindo o painel em http://localhost:8000 ...
timeout /t 3 /nobreak >nul
start "" http://localhost:8000
node server.js
pause
