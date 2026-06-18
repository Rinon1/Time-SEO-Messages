Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\Rinon\Desktop\Rinon\Time SEO\Website"
WshShell.Run "cmd /c node server.js", 0, False
