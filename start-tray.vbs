Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = scriptDir & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(electronExe) Then
  WshShell.CurrentDirectory = scriptDir
  WshShell.Run """" & electronExe & """ """ & scriptDir & """", 0, False
Else
  WshShell.CurrentDirectory = scriptDir
  WshShell.Run "cmd /c npm start", 0, False
End If
