@echo off
rem Para o painel (mata só o processo na porta 8000).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:8000" ^| findstr "LISTENING"') do taskkill /F /PID %%a
echo Painel parado. Feche esta janela.
