Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\Rinon\Desktop\Rinon\Time SEO\Website"
Do
    WshShell.Run "cmd /c node server.js", 0, True
    WScript.Sleep 3000
Loop
