"""Drives the Claude desktop app through Windows UI Automation.

Everything goes through accessibility patterns (Invoke / ExpandCollapse / Toggle /
Value), never the mouse or keyboard, so it also works while the PC is locked or the
window is behind other windows.
"""
import ctypes
import os
import subprocess
import time

import uiautomation as auto
from uiautomation.uiautomation import _AutomationClient

CLAUDE_APP_ID = r'shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude'
WINDOW_CLASS = 'Chrome_WidgetWin_1'

_uia = _AutomationClient.instance().IUIAutomation
_PROPS = (
    auto.PropertyId.NameProperty,
    auto.PropertyId.ControlTypeProperty,
    auto.PropertyId.ClassNameProperty,
    auto.PropertyId.AutomationIdProperty,
    auto.PropertyId.AriaPropertiesProperty,
    auto.PropertyId.BoundingRectangleProperty,
)
_user32 = ctypes.windll.user32


class ClaudeUIError(Exception):
    pass


class Node:
    """A cached snapshot of one element; .el stays live for actions."""
    __slots__ = ('el', 'name', 'type', 'cls', 'aid', 'aria', 'children', 'parent')

    def __init__(self, el, parent=None):
        self.el = el
        self.parent = parent
        self.name = el.CachedName or ''
        self.type = el.CachedControlType
        self.cls = el.CachedClassName or ''
        self.aid = el.CachedAutomationId or ''
        self.aria = _aria(el.GetCachedPropertyValue(auto.PropertyId.AriaPropertiesProperty))
        kids = el.GetCachedChildren()
        self.children = [Node(kids.GetElement(i), self) for i in range(kids.Length)] if kids else []

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def find(self, pred):
        return next((n for n in self.walk() if pred(n)), None)

    def find_all(self, pred):
        return [n for n in self.walk() if pred(n)]


def _aria(raw):
    out = {}
    for part in (raw or '').split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            out[k] = v
    return out


def snapshot(control):
    cr = _uia.CreateCacheRequest()
    for p in _PROPS:
        cr.AddProperty(p)
    cr.TreeScope = 7  # element + subtree
    cr.TreeFilter = _uia.RawViewCondition
    el = control.Element if hasattr(control, 'Element') else control
    return Node(el.BuildUpdatedCache(cr))


def _is_button(n):
    return n.type == auto.ControlType.ButtonControl


def _ctl(el):
    return auto.Control.CreateControlFromElement(el)


def _pattern(el, pid):
    try:
        return _ctl(el).GetPattern(pid)
    except Exception:
        return None


def _press(el):
    """Default action (a DOM click) through accessibility, no mouse involved."""
    inv = _pattern(el, auto.PatternId.InvokePattern)
    if inv:
        inv.Invoke()
        return
    leg = _pattern(el, auto.PatternId.LegacyIAccessiblePattern)
    if not leg:
        raise ClaudeUIError('element has no default action')
    leg.DoDefaultAction()


def _wait(fn, timeout, interval=0.25):
    end = time.time() + timeout
    while True:
        v = fn()
        if v:
            return v
        if time.time() > end:
            return v
        time.sleep(interval)


class ClaudeUI:
    def __init__(self, log=print):
        self.log = log
        self._win = None

    # ---- window ---------------------------------------------------------
    def _find_window(self):
        root = auto.GetRootControl()
        for w in root.GetChildren():
            if w.ClassName == WINDOW_CLASS and w.Name == 'Claude' and w.ControlTypeName == 'WindowControl':
                try:
                    pid = w.ProcessId
                    exe = _process_path(pid)
                except Exception:
                    exe = ''
                if 'Claude' in exe and 'claude-code' not in exe:
                    return w
        return None

    def window(self, launch=True):
        w = self._find_window()
        if not w and launch:
            self.log('Claude is not running - launching it')
            subprocess.Popen(['explorer.exe', CLAUDE_APP_ID])
            w = _wait(self._find_window, 60, 1)
            if not w:
                raise ClaudeUIError('Claude desktop did not start')
            time.sleep(5)
        if not w:
            raise ClaudeUIError('Claude desktop is not running')
        hwnd = w.NativeWindowHandle
        if _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, 9)  # SW_RESTORE - a minimized Chromium window stops updating
            time.sleep(1.0)
        self._win = w
        return w

    def _document(self):
        """The web document that holds the app UI (the one with the sidebar)."""
        w = self.window()
        for _ in range(3):
            docs = []
            for d in _descendant_docs(w):
                if d.Name and d.BoundingRectangle.width() > 0:
                    docs.append(d)
            for d in docs:
                n = snapshot(d)
                if n.find(lambda x: x.name == 'Sidebar' and 'dframe-sidebar' in x.cls) or n.find(lambda x: x.name == 'Mode'):
                    return d, n
            time.sleep(1.5)  # first query switches Chromium accessibility on; give it a moment
        raise ClaudeUIError('Could not read the Claude window (is it on the Code tab?)')

    def ensure_code_mode(self, doc_node):
        mode = doc_node.find(lambda x: x.name == 'Mode' and x.type == auto.ControlType.GroupControl)
        if not mode:
            return False
        code = mode.find(lambda x: x.type == auto.ControlType.RadioButtonControl and x.name == 'Code')
        if code and code.aria.get('checked') != 'true':
            self.log('Switching Claude to the Code tab')
            _press(code.el)
            time.sleep(1.5)
            return True
        return False

    def ensure_sidebar(self, doc_node):
        if doc_node.find(lambda x: x.name == 'Sidebar' and 'dframe-sidebar' in x.cls):
            return False
        btn = doc_node.find(lambda x: _is_button(x) and x.name == 'Show sidebar')
        if btn:
            self.log('Opening the sidebar')
            _press(btn.el)
            time.sleep(1.0)
            return True
        return False

    def _ready_doc(self):
        doc, n = self._document()
        changed = self.ensure_code_mode(n)
        changed = self.ensure_sidebar(n if not changed else snapshot(doc)) or changed
        if changed:
            n = snapshot(doc)
        return doc, n

    # ---- reading --------------------------------------------------------
    def current_title(self, n=None):
        if n is None:
            _, n = self._document()
        b = n.find(lambda x: _is_button(x) and x.name.endswith(', rename session'))
        return b.name[: -len(', rename session')] if b else None

    def list_sessions(self, expand_collapsed=True):
        doc, n = self._ready_doc()
        sidebar = n.find(lambda x: x.name == 'Sidebar' and 'dframe-sidebar' in x.cls)
        if not sidebar:
            raise ClaudeUIError('Sidebar not found')
        if expand_collapsed and self._expand_sections(sidebar):
            n = snapshot(doc)
            sidebar = n.find(lambda x: x.name == 'Sidebar' and 'dframe-sidebar' in x.cls)
        current = self.current_title(n)
        sessions = []
        for sec in sidebar.find_all(lambda x: 'group/section' in x.cls):
            header = next((c for c in sec.children if _is_button(c)), None)
            section = header.name if header else ''
            for item in sec.find_all(_is_session_button):
                status, title = _parse_item(item)
                occurrence = sum(1 for s in sessions if s['title'] == title)
                sessions.append({
                    'index': len(sessions),
                    'title': title,
                    'status': status,
                    'section': section,
                    'occurrence': occurrence,
                    'current': title == current and occurrence == 0,
                })
        return {'sessions': sessions, 'current': current}

    def _expand_sections(self, sidebar):
        changed = False
        for sec in sidebar.find_all(lambda x: 'group/section' in x.cls):
            header = next((c for c in sec.children if _is_button(c)), None)
            if header and header.aria.get('expanded') == 'false' and not sec.find(_is_session_button):
                try:
                    _press(header.el)
                    changed = True
                except Exception:
                    pass
        if changed:
            time.sleep(0.8)
        return changed

    def _session_buttons(self):
        doc, n = self._ready_doc()
        sidebar = n.find(lambda x: x.name == 'Sidebar' and 'dframe-sidebar' in x.cls)
        items = []
        for sec in sidebar.find_all(lambda x: 'group/section' in x.cls) if sidebar else []:
            items.extend(sec.find_all(_is_session_button))
        return doc, items

    # ---- actions --------------------------------------------------------
    def open_session(self, title, occurrence=0):
        doc, items = self._session_buttons()
        matches = [it for it in items if _parse_item(it)[1] == title]
        if len(matches) <= occurrence:
            raise ClaudeUIError(f'Session not found in the sidebar: {title}')
        target = matches[occurrence]
        self.log(f'Opening session: {title}')
        _press(target.el)
        ok = _wait(lambda: self.current_title(snapshot(doc)) == title, 15, 0.4)
        if not ok:
            raise ClaudeUIError(f'Clicked "{title}" but it did not open')
        time.sleep(0.8)
        return doc

    def _rc_button(self, doc):
        n = snapshot(doc)
        b = _wait(lambda: n.find(lambda x: _is_button(x) and x.name == 'Remote Control') or None, 0)
        if not b:
            b = _wait(lambda: snapshot(doc).find(lambda x: _is_button(x) and x.name == 'Remote Control'), 8, 0.5)
        return b

    def _open_rc_menu(self, doc):
        b = self._rc_button(doc)
        if not b:
            raise ClaudeUIError('This session has no Remote Control button (it may need to run a turn first)')
        ec = _pattern(b.el, auto.PatternId.ExpandCollapsePattern)
        if ec:
            ec.Expand()
        else:
            _press(b.el)

        def menu():
            m = snapshot(self._win).find(lambda x: x.type == auto.ControlType.MenuControl and x.name == 'Remote Control')
            return m
        m = _wait(menu, 5, 0.3)
        if not m:
            raise ClaudeUIError('Remote Control menu did not open')
        return b, m

    def _close_rc_menu(self, b):
        try:
            ec = _pattern(b.el, auto.PatternId.ExpandCollapsePattern)
            if ec:
                ec.Collapse()
        except Exception:
            pass
        time.sleep(0.3)
        if snapshot(self._win).find(lambda x: x.type == auto.ControlType.MenuControl and x.name == 'Remote Control'):
            try:
                _press(b.el)  # toggles the menu closed
            except Exception:
                pass

    def _remote_control_menu(self, doc, enable=True):
        """Older builds: Remote Control lives in a title-bar menu with a switch and the link."""
        b, m = self._open_rc_menu(doc)
        try:
            box = m.find(lambda x: x.type == auto.ControlType.CheckBoxControl)
            if not box:
                raise ClaudeUIError('Remote Control switch not found in the menu')
            checked = box.aria.get('checked') == 'true'
            if checked != enable:
                self.log(('Turning Remote Control on' if enable else 'Turning Remote Control off'))
                tg = _pattern(box.el, auto.PatternId.TogglePattern)
                if tg:
                    tg.Toggle()
                else:
                    _press(box.el)

            def state():
                mm = snapshot(self._win).find(lambda x: x.type == auto.ControlType.MenuControl and x.name == 'Remote Control')
                if not mm:
                    return None
                bx = mm.find(lambda x: x.type == auto.ControlType.CheckBoxControl)
                link_el = mm.find(lambda x: x.type == auto.ControlType.EditControl and 'link' in x.name.lower())
                on = bool(bx) and bx.aria.get('checked') == 'true'
                link = _value(link_el.el) if link_el else None
                if enable and not (on and link):
                    return None
                if not enable and on:
                    return None
                return {'enabled': on, 'link': link}
            res = _wait(state, 45 if enable else 10, 0.5)
            if not res:
                # The menu may have closed on toggle; reopen once and read again.
                self._close_rc_menu(b)
                b, m = self._open_rc_menu(doc)
                res = _wait(state, 20, 0.5)
            if not res:
                raise ClaudeUIError('Remote Control did not ' + ('connect' if enable else 'turn off') + ' in time')
            return res
        finally:
            self._close_rc_menu(b)

    def _rc_status_menu(self, doc):
        b, m = self._open_rc_menu(doc)
        try:
            box = m.find(lambda x: x.type == auto.ControlType.CheckBoxControl)
            link_el = m.find(lambda x: x.type == auto.ControlType.EditControl and 'link' in x.name.lower())
            return {'enabled': bool(box) and box.aria.get('checked') == 'true',
                    'link': _value(link_el.el) if link_el else None}
        finally:
            self._close_rc_menu(b)

    # ---- Remote Control (newer builds: a switch in the "Session details" rail) ----
    def _rc_toggle(self, doc, wait=8):
        def find():
            n = snapshot(doc)
            b = n.find(lambda x: _is_button(x) and x.name == 'Remote Control')
            if not b:
                show = n.find(lambda x: _is_button(x) and x.name == 'Show session rail')
                if show:
                    self.log('Opening the session rail')
                    _press(show.el)
                    time.sleep(0.8)
            return b
        return _wait(find, wait, 0.5)

    def remote_control(self, doc, enable=True, title=None):
        """Returns {'enabled': bool, 'link': str|None} after making RC match `enable`."""
        b = self._rc_toggle(doc)
        if not b:
            raise ClaudeUIError('This session has no Remote Control switch (it may need to run a turn first)')
        if b.aria.get('haspopup'):
            return self._remote_control_menu(doc, enable)
        title = title or self.current_title()
        before = _bridge_ids(title)
        if (b.aria.get('pressed') == 'true') != enable:
            self.log('Turning Remote Control on' if enable else 'Turning Remote Control off')
            tg = _pattern(b.el, auto.PatternId.TogglePattern)
            if tg:
                tg.Toggle()
            else:
                _press(b.el)

        def state():
            bb = snapshot(doc).find(lambda x: _is_button(x) and x.name == 'Remote Control')
            return bb if bb and (bb.aria.get('pressed') == 'true') == enable else None
        if not _wait(state, 30 if enable else 10, 0.5):
            raise ClaudeUIError('Remote Control did not ' + ('connect' if enable else 'turn off') + ' in time')
        link = None
        if enable:
            # A fresh connection may add a new remote id a moment after the switch flips.
            ids = _wait(lambda: (lambda now: now if now and now != before else None)(_bridge_ids(title)), 8, 0.5) or _bridge_ids(title)
            link = f'https://claude.ai/code/{ids[-1]}' if ids else None
        return {'enabled': enable, 'link': link}

    def rc_status(self, doc=None):
        if doc is None:
            doc, _ = self._ready_doc()
        b = self._rc_toggle(doc)
        if not b:
            raise ClaudeUIError('This session has no Remote Control switch')
        if b.aria.get('haspopup'):
            return self._rc_status_menu(doc)
        on = b.aria.get('pressed') == 'true'
        ids = _bridge_ids(self.current_title()) if on else []
        return {'enabled': on, 'link': f'https://claude.ai/code/{ids[-1]}' if ids else None}

    def is_cloud(self, doc):
        """Cloud sessions carry a 'Cloud' badge in the title bar; they need no Remote Control."""
        bar = snapshot(doc).find(lambda x: 'epitaxy-titlebar' in x.cls)
        return bool(bar and bar.find(lambda x: _is_button(x) and x.name == 'Cloud'))

    def connect(self, title, occurrence=0):
        doc = self.open_session(title, occurrence)
        if self.is_cloud(doc):
            self.log('Cloud session - already reachable from the phone')
            return {'title': title, 'enabled': True, 'cloud': True, 'link': None}
        res = self.remote_control(doc, True, title)
        res['title'] = title
        return res

    def disconnect(self, title, occurrence=0):
        doc = self.open_session(title, occurrence)
        if self.is_cloud(doc):
            raise ClaudeUIError('This is a cloud session - it has no Remote Control to turn off')
        res = self.remote_control(doc, False, title)
        res['title'] = title
        return res


def _is_session_button(n):
    """A session row: the wide row button inside a draggable sidebar item (markup varies by app version)."""
    if not (_is_button(n) and n.cls.startswith('w-full shrink-0')):
        return False
    p, depth = n.parent, 0
    while p is not None and depth < 4:
        if 'df-drag-shiftable' in p.cls:
            return True
        p, depth = p.parent, depth + 1
    return False


def _in_sr_only(x):
    p = x.parent
    while p is not None:
        if 'sr-only' in p.cls:
            return True
        if _is_session_button(p):
            return False
        p = p.parent
    return False


def _parse_item(item):
    texts = [x for x in item.walk() if x.type == auto.ControlType.TextControl and x.name]
    title_el = next((x for x in texts if not _in_sr_only(x)), None)
    title = title_el.name if title_el else item.name
    # Newer builds: status is screen-reader text; older: an icon/status child named "Idle"/"Running".
    status_el = next((x for x in texts if _in_sr_only(x)), None)         or next((c for c in item.children if c.name and c.type not in (auto.ControlType.GroupControl, auto.ControlType.TextControl)), None)
    status = status_el.name if status_el else 'Idle'
    return status, title


SESSIONS_DIR = os.path.join(os.environ.get('APPDATA', ''), 'Claude', 'claude-code-sessions')


def _bridge_ids(title):
    """Remote (claude.ai) session ids the app recorded for the local session with this title."""
    import glob
    import json
    best = None
    for f in glob.glob(os.path.join(SESSIONS_DIR, '*', '*', 'local_*.json')):
        try:
            with open(f, encoding='utf-8') as fh:
                d = json.load(fh)
        except Exception:
            continue
        if d.get('title') != title or d.get('isArchived'):
            continue
        if best is None or (d.get('lastActivityAt') or 0) > (best.get('lastActivityAt') or 0):
            best = d
    ids = (best or {}).get('bridgeSessionIds') or []
    return [i for i in ids if isinstance(i, str) and i.startswith('session_')]


def _value(el):
    vp = _pattern(el, auto.PatternId.ValuePattern)
    try:
        return (vp.Value or None) if vp else None
    except Exception:
        return None


def _descendant_docs(w):
    cond = _uia.CreatePropertyCondition(auto.PropertyId.AutomationIdProperty, 'RootWebArea')
    arr = w.Element.FindAll(4, cond)
    return [auto.Control.CreateControlFromElement(arr.GetElement(i)) for i in range(arr.Length)] if arr else []


def _process_path(pid):
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = ctypes.c_ulong(1024)
        ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
        return buf.value
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


def screenshot_png(max_width=1280):
    from io import BytesIO
    from PIL import ImageGrab
    img = ImageGrab.grab(all_screens=False)
    if img.width > max_width:
        img = img.resize((max_width, round(img.height * max_width / img.width)))
    buf = BytesIO()
    img.convert('RGB').save(buf, 'JPEG', quality=70)
    return buf.getvalue()


if os.name != 'nt':
    raise SystemExit('Windows only')
