' Inicia o painel escondido (sem janela), ex: via Inicializar do Windows.
Dim fso, dir, shell
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c cd /d """ & dir & """ && node server.js", 0, False
