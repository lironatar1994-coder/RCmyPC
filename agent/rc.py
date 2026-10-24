"""Local CLI: list Claude sessions, pick one, turn on Remote Control.

  python rc.py              interactive: list -> choose -> connect
  python rc.py list         print the sidebar sessions
  python rc.py connect N    connect session number N (from `list`)
  python rc.py status       Remote Control state of the open session
"""
import io
import sys

from claude_ui import ClaudeUI, ClaudeUIError

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)


def show(sessions):
    section = None
    for s in sessions:
        if s['section'] != section:
            section = s['section']
            print(f'\n  {section}')
        mark = '*' if s['current'] else ' '
        print(f"  {mark}{s['index'] + 1:>3}. {s['title']}  [{s['status']}]")


def main(argv):
    ui = ClaudeUI(log=lambda m: print('  ..', m))
    cmd = argv[0] if argv else 'interactive'
    try:
        if cmd == 'status':
            print(ui.rc_status())
            return
        data = ui.list_sessions()
        sessions = data['sessions']
        if cmd == 'list':
            show(sessions)
            return
        if cmd == 'connect':
            n = int(argv[1])
        else:
            show(sessions)
            n = int(input('\nSession number to connect: ').strip())
        s = sessions[n - 1]
        res = ui.connect(s['title'], s['occurrence'])
        print(f"\nRemote Control {'ON' if res['enabled'] else 'OFF'}: {s['title']}")
        if res.get('link'):
            print(f"Open on your phone: {res['link']}")
    except ClaudeUIError as e:
        print('Error:', e)
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1:])
