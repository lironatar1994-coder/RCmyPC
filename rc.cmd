@echo off
rem Local version of the panel: list Claude sessions, pick one, turn on Remote Control.
python "%~dp0agent\rc.py" %*
