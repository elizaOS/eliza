# ---------------------------------------------------------------------------
# 1) Desktop automation backend (PyAutoGUI)
# ---------------------------------------------------------------------------
import os
import io
from typing import Optional
from desktop_env.desktop_env import DesktopEnv
from ..Action import (
    Action,
    Click,
    DoubleClick,
    Move,
    Scroll,
    Drag,
    TypeText,
    Hotkey,
    Wait,
    Done,
    Failed,
    Screenshot,
    SetCellValues,
    SwitchApplications,
    Open
)
from ...utils.common_utils import screenshot_bytes_to_pil_image
from .Backend import Backend
import time

class PyAutoGUIVMwareBackend(Backend):
    """VMware desktop backend powered by *pyautogui*.

    Pros  : zero dependency besides Python & pyautogui.
    Cons  : Requires an active, visible desktop session (won't work headless).
    """

    _supported = {Click, DoubleClick, Move, Scroll, Drag, TypeText, Hotkey, Wait, Done, Failed, Screenshot, SetCellValues, SwitchApplications, Open}

    # ¶ PyAutoGUI sometimes throws exceptions if mouse is moved to a corner.
    def __init__(self, default_move_duration: float = 0.0, platform: str | None = None, **kwargs):
        import pyautogui as pag  # local import to avoid hard requirement
        pag.FAILSAFE = False
        self.pag = pag
        self.default_move_duration = default_move_duration
        # Extract env_controller from kwargs if provided, but don't require it
        self.env_controller: Optional[DesktopEnv] = kwargs.get('env_controller', None)
        self.platform = platform


    # ------------------------------------------------------------------
    def execute(self, action: Action) -> str: # type: ignore
        if not self.supports(type(action)):
            raise NotImplementedError(f"{type(action).__name__} not supported by PyAutoGUIBackend")
        
        # For automation OSWorld evaluation
        if self.env_controller is None: 
            if isinstance(action, Click):
                return self._click(action)
            elif isinstance(action, DoubleClick):
                return self._doubleClick(action)
            elif isinstance(action, Move):
                return self._move(action)
            elif isinstance(action, Scroll):
                return self._scroll(action)
            elif isinstance(action, Drag):
                return self._drag(action)
            elif isinstance(action, TypeText):
                return self._type(action)
            elif isinstance(action, Hotkey):
                return self._hotkey(action)
            elif isinstance(action, Screenshot):
                screenshot = self._screenshot()
                return screenshot # type: ignore
            elif isinstance(action, Wait):
                return f"WAIT"
            elif isinstance(action, Done):
                return f"DONE"
            elif isinstance(action, Failed):
                return f"FAIL"
            elif isinstance(action, SetCellValues):
                return self._set_cell_values(action)
            elif isinstance(action, SwitchApplications):
                return self._switch_applications(action)
            elif isinstance(action, Open):
                return self._open(action)
            else:
                # This shouldn't happen due to supports() check, but be safe.
                raise NotImplementedError(f"Unhandled action: {action}")
        
        # For cli_app
        else:
            if isinstance(action, Click):
                action_pyautogui_code = self._click(action)
            elif isinstance(action, DoubleClick):
                action_pyautogui_code = self._doubleClick(action)
            elif isinstance(action, Move):
                action_pyautogui_code = self._move(action)
            elif isinstance(action, Scroll):
                action_pyautogui_code = self._scroll(action)
            elif isinstance(action, Drag):
                action_pyautogui_code = self._drag(action)
            elif isinstance(action, TypeText):
                action_pyautogui_code = self._type(action)
            elif isinstance(action, Hotkey):
                action_pyautogui_code = self._hotkey(action)
            elif isinstance(action, Screenshot):
                screenshot = self._screenshot()
                return screenshot # type: ignore
            elif isinstance(action, Wait):
                action_pyautogui_code = f"WAIT"
            elif isinstance(action, Done):
                action_pyautogui_code = f"DONE"
            elif isinstance(action, Failed):
                action_pyautogui_code = f"FAIL"
            elif isinstance(action, SetCellValues):
                action_pyautogui_code = self._set_cell_values(action)
            elif isinstance(action, SwitchApplications):
                action_pyautogui_code = self._switch_applications(action)
            elif isinstance(action, Open):
                action_pyautogui_code = self._open(action)
            else:
                # This shouldn't happen due to supports() check, but be safe.
                raise NotImplementedError(f"Unhandled action: {action}")

            pause = 2 if action_pyautogui_code != "WAIT" else action.duration * 1e-3
            self.env_controller.step(action_pyautogui_code, pause)

    # ----- individual helpers ------------------------------------------------
    def _click(self, act: Click) -> str:
        button_str = 'primary'
        if act.button == 1:
            button_str = "left"
        elif act.button == 4:
            button_str = "middle"
        elif act.button == 2:
            button_str = "right"

        hold_keys = act.holdKey or []
        code_parts = []
        for k in hold_keys:
            code_parts.append(f"pyautogui.keyDown('{k}')")
            code_parts.append(f"time.sleep(0.05)")
        code_parts.append(f"pyautogui.click(x={act.x}, y={act.y}, clicks=1, button='{button_str}', duration={self.default_move_duration}, interval=0.1)")
        for k in hold_keys:
            code_parts.append(f"pyautogui.keyUp('{k}')")
        return "; ".join(code_parts)

    def _doubleClick(self, act: DoubleClick) -> str:
        
        button_str = 'primary'
        if act.button == 1:
            button_str = "left"
        elif act.button == 4:
            button_str = "middle"
        elif act.button == 2:
            button_str = "right"


        hold_keys = act.holdKey or []
        code_parts = []
        for k in hold_keys:
            code_parts.append(f"pyautogui.keyDown('{k}')")
            code_parts.append(f"time.sleep(0.05)")
        code_parts.append(f"pyautogui.click(x={act.x}, y={act.y}, clicks=2, button='{button_str}', duration={self.default_move_duration}, interval=0.1)")
        for k in hold_keys:
            code_parts.append(f"pyautogui.keyUp('{k}')")
        return "; ".join(code_parts)

    def _move(self, act: Move) -> str:
        code_parts = []
        for k in act.holdKey or []:
            code_parts.append(f"pyautogui.keyDown('{k}')")
            code_parts.append(f"time.sleep(0.05)")
        code_parts.append(f"pyautogui.moveTo(x = {act.x}, y = {act.y})")
        for k in act.holdKey or []:
            code_parts.append(f"pyautogui.keyUp('{k}')")
        return "; ".join(code_parts)

    def _scroll(self, act: Scroll) -> str:
        code_parts = []
        
        for k in act.holdKey or []:
            code_parts.append(f"pyautogui.keyDown('{k}')")
            code_parts.append(f"time.sleep(0.05)")

        code_parts.append(f"pyautogui.moveTo(x = {act.x}, y = {act.y})")
        if act.stepVertical is None:
            if act.stepHorizontal is not None:
                code_parts.append(f"pyautogui.hscroll({act.stepHorizontal})")
        else:
            code_parts.append(f"pyautogui.vscroll({act.stepVertical})")
        
        for k in act.holdKey or []:
            code_parts.append(f"pyautogui.keyUp('{k}')")

        return "; ".join(code_parts)

    def _drag(self, act: Drag) -> str:
        hold_keys = act.holdKey or []
        code_parts = []
        for k in hold_keys:
            code_parts.append(f"pyautogui.keyDown('{k}')")
            code_parts.append(f"time.sleep(0.05)")
        
        code_parts.append(f"pyautogui.moveTo(x = {act.startX}, y = {act.startY})")
        code_parts.append("time.sleep(0.1)")

        code_parts.append(f"pyautogui.mouseDown(button='left')")
        code_parts.append("time.sleep(0.2)")

        code_parts.append(f"pyautogui.moveTo(x = {act.endX}, y = {act.endY}, duration=0.5)")
        code_parts.append("time.sleep(0.1)")

        code_parts.append(f"pyautogui.mouseUp(button='left')")

        for k in hold_keys:
            code_parts.append(f"pyautogui.keyUp('{k}')")
        return "; ".join(code_parts)

    def _type(self, act: TypeText) -> str:
        code_parts = []
        # 1) Optional focus
        if act.x is not None and act.y is not None:
            code_parts.append(f"pyautogui.click({act.x}, {act.y}, clicks=2, interval=0.1)")
            code_parts.append("time.sleep(0.05)")
        # 2) Optional overwrite
        if act.overwrite:
            code_parts.append("pyautogui.hotkey('ctrl', 'a', interval=0.2)")
            code_parts.append("time.sleep(0.05)")
            code_parts.append("pyautogui.press('backspace')")
            code_parts.append("time.sleep(0.05)")
        # 3) Type text by write in VMware codegen path
        code_parts.append("pyautogui.write(" + repr(act.text) + ")")
        # 4) Optional enter
        if act.enter:
            code_parts.append("pyautogui.press('enter')")
        return "; ".join(code_parts)

    def _hotkey(self, act: Hotkey) -> str:
        code_parts = []
        if act.duration is not None:
            for k in act.keys or []:
                code_parts.append(f"pyautogui.keyDown('{k}')")
                code_parts.append(f"time.sleep({act.duration} * 1e-3)")
            for k in reversed(act.keys):
                code_parts.append(f"pyautogui.keyUp('{k}')")
        else:
            keys_str = "', '".join(act.keys)
            code_parts.append(f"pyautogui.hotkey('{keys_str}', interval=0.1)")
        return "; ".join(code_parts)
    
    def _screenshot(self) -> str:
        if self.env_controller is None:
            return "screenshot = pyautogui.screenshot(); return screenshot"
        else:
            obs = self.env_controller._get_obs()
            return screenshot_bytes_to_pil_image(obs["screenshot"]) #type: ignore

    def _set_cell_values(self, act: SetCellValues) -> str:
        """Set cell values in LibreOffice Calc (Linux only)"""
        if self.platform == "Ubuntu":
            # Create Python script for LibreOffice automation
            script_content = f"""
import uno
import subprocess

def identify_document_type(component):
    if component.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        return "Calc"

    if component.supportsService("com.sun.star.text.TextDocument"):
        return "Writer"

    if component.supportsService("com.sun.star.sheet.PresentationDocument"):
        return "Impress"

    return None

def cell_ref_to_indices(cell_ref):
    column_letters = ''.join(filter(str.isalpha, cell_ref))
    row_number = ''.join(filter(str.isdigit, cell_ref))

    col = sum((ord(char.upper()) - ord('A') + 1) * (26**idx) for idx, char in enumerate(reversed(column_letters))) - 1
    row = int(row_number) - 1
    return col, row

def set_cell_values(new_cell_values: dict[str, str], app_name: str = "Untitled 1", sheet_name: str = "Sheet1"):
    new_cell_values_idx = {{}}
    for k, v in new_cell_values.items():
        try:
            col, row = cell_ref_to_indices(k)
        except:
            col = row = None

        if col is not None and row is not None:
            new_cell_values_idx[(col, row)] = v

    # Clean up previous TCP connections.
    # The command may fail if no such connections exist, so we don't check for exit code.
    subprocess.run(
        'echo \"osworld-public-evaluation\" | sudo -S ss --kill --tcp state TIME-WAIT sport = :2002',
        shell=True,
        check=False,
        text=True,
        capture_output=True
    )

    # Dynamically allow soffice to listen on port 2002.
    # Use Popen to run soffice in the background.
    soffice_process = subprocess.Popen(
        [
            "soffice",
            "--headless",
            "--invisible",
            "--accept=socket,host=localhost,port=2002;urp;StarOffice.Service"
        ]
    )

    # Wait for soffice to start
    import time
    time.sleep(3)

    try:
        local_context = uno.getComponentContext()
        resolver = local_context.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local_context
        )
        context = resolver.resolve(
            f"uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext"
        )
        desktop = context.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", context
        )

        # Collect all LibreOffice-related opened windows.
        documents = []
        for i, component in enumerate(desktop.Components):
            title = component.Title
            doc_type = identify_document_type(component)
            documents.append((i, component, title, doc_type))

        # Find the LibreOffice Calc app and the sheet of interest.
        spreadsheet = [doc for doc in documents if doc[3] == "Calc"]
        selected_spreadsheet = [doc for doc in spreadsheet if doc[2] == app_name]
        if spreadsheet:
            try:
                if selected_spreadsheet:
                    spreadsheet = selected_spreadsheet[0][1]
                else:
                    spreadsheet = spreadsheet[0][1]

                sheet = spreadsheet.Sheets.getByName(sheet_name)
            except:
                raise ValueError(f"Could not find sheet {{sheet_name}} in {{app_name}}.")

            for (col, row), value in new_cell_values_idx.items():
                cell = sheet.getCellByPosition(col, row)

                # Set the cell value.
                if isinstance(value, (int, float)):
                    cell.Value = value
                elif isinstance(value, str):
                    if value.startswith("="):
                        cell.Formula = value
                    else:
                        cell.String = value
                elif isinstance(value, bool):
                    cell.Value = 1 if value else 0
                elif value is None:
                    cell.clearContents(0)
                else:
                    raise ValueError(f"Unsupported cell value type: {{type(value)}}")

        else:
            raise ValueError(f"Could not find LibreOffice Calc app corresponding to {{app_name}}.")
    finally:
        # Terminate the soffice process
        soffice_process.terminate()
        soffice_process.wait()

set_cell_values(new_cell_values={act.cell_values}, app_name="{act.app_name}", sheet_name="{act.sheet_name}")
"""
            return script_content
        else:
            return f"# SetCellValues not supported on platform: {self.platform}" # type: ignore

    def _switch_applications(self, act: SwitchApplications) -> str:
        """Switch to a different application that is already open"""
        if self.platform == "Ubuntu":
            # Linux: Use wmctrl to switch windows with improved matching
            return f"""
import subprocess
import difflib
import pyautogui
import time

def _normalize(s):
    return "".join(ch.lower() for ch in s if ch.isalnum())

def _parse_app_code(app_code):
    if ":" in app_code:
        cls, ttl = app_code.split(":", 1)
        return cls.strip(), ttl.strip()
    return app_code.strip(), None

# Extended app mapping with common variations
APP_CLASS_MAP = {{
    "chrome": ["google-chrome.Google-chrome", "chromium.Chromium"],
    "chromium": ["chromium.Chromium"],
    "code": ["code.Code"],
    "vscode": ["code.Code"],
    "visual": ["code.Code"],
    "studio": ["code.Code"],
    "impress": ["libreoffice.libreoffice-impress"],
    "calc": ["libreoffice.libreoffice-calc"],
    "libreoffice": ["libreoffice.libreoffice-calc", "libreoffice.libreoffice-impress"],
    "office": ["libreoffice.libreoffice-calc", "libreoffice.libreoffice-impress"],
    "terminal": ["gnome-terminal-server.Gnome-terminal"],
    "gnome-terminal": ["gnome-terminal-server.Gnome-terminal"],
    "nautilus": ["org.gnome.Nautilus.Org.gnome.Nautilus"],
    "files": ["org.gnome.Nautilus.Org.gnome.Nautilus"],
    "filemanager": ["org.gnome.Nautilus.Org.gnome.Nautilus"],
    "software": ["org.gnome.Software.Org.gnome.Software"],
    "firefox": ["firefox.Firefox"],
    "browser": ["firefox.Firefox", "google-chrome.Google-chrome", "chromium.Chromium"],
}}

def _match_by_class(entries, cls_key):
    cls_key_n = _normalize(cls_key)
    # 1) Alias exact match
    if cls_key_n in APP_CLASS_MAP:
        targets = {{_normalize(x) for x in APP_CLASS_MAP[cls_key_n]}}
        exact_alias = [e for e in entries if _normalize(e[1]) in targets]
        if exact_alias:
            return exact_alias
    # 2) Exact match
    exact = [e for e in entries if _normalize(e[1]) == cls_key_n]
    if exact:
        return exact
    # 3) Prefix/contains
    pref = [e for e in entries if _normalize(e[1]).startswith(cls_key_n)]
    if pref:
        return pref
    sub = [e for e in entries if cls_key_n in _normalize(e[1])]
    if sub:
        return sub
    # 4) Fuzzy fallback (higher threshold)
    wm_classes = [e[1] for e in entries]
    matches = difflib.get_close_matches(cls_key, wm_classes, n=3, cutoff=0.6)
    if matches:
        chosen = matches[0]
        return [e for e in entries if e[1] == chosen]
    return []

def _match_by_title(candidates, title_key):
    ttl_n = _normalize(title_key)
    # Exact
    exact = [e for e in candidates if _normalize(e[2]) == ttl_n]
    if exact:
        return exact[0]
    # Contains
    sub = [e for e in candidates if ttl_n in _normalize(e[2])]
    if sub:
        return sub[0]
    # Fuzzy
    titles = [e[2] for e in candidates]
    matches = difflib.get_close_matches(title_key, titles, n=1, cutoff=0.6)
    if matches:
        chosen = matches[0]
        for e in candidates:
            if e[2] == chosen:
                return e
    return None

try:
    pyautogui.press('escape')
    time.sleep(0.5)

    output = subprocess.check_output(['wmctrl', '-lx'])
    output = output.decode('utf-8').splitlines()
    
    # Parse entries: (window_id, wm_class, title, raw_line)
    entries = []
    for raw in output:
        if not raw or not raw.strip():
            continue
        parts = raw.split(None, 4)
        if len(parts) < 3:
            continue
        window_id = parts[0]
        wm_class = parts[2]
        title = parts[4] if len(parts) >= 5 else ""
        entries.append((window_id, wm_class, title, raw))

    if not entries:
        print("[SwitchApplications] no valid entries found")
        exit(0)

    # Match by class first, then by title if multiple candidates
    cls_key, title_key = _parse_app_code('{act.app_code}')
    candidates = _match_by_class(entries, cls_key)
    
    if not candidates:
        print(f"[SwitchApplications] no class match for '{{cls_key}}'")
        exit(0)
    
    chosen_entry = None
    if len(candidates) == 1 or not title_key:
        chosen_entry = candidates[0]
    else:
        chosen_entry = _match_by_title(candidates, title_key)
        if chosen_entry is None:
            # Fallback to first candidate
            chosen_entry = candidates[0]
    
    window_id, wm_class, title, raw = chosen_entry
    print(f"[SwitchApplications] selected: {{wm_class}} - {{title}}")
    
    # Activate and maximize
    subprocess.run(['wmctrl', '-ia', window_id])
    subprocess.run(['wmctrl', '-ir', window_id, '-b', 'add,maximized_vert,maximized_horz'])

except Exception as e:
    print(f"[SwitchApplications] exception: {{e}}", flush=True)
"""
        elif self.platform == "Windows":
            # Windows: Win+D to show desktop, then type app name
            return f"""
import pyautogui
import time

pyautogui.hotkey('win', 'd', interval=0.1)
time.sleep(0.5)
pyautogui.typewrite(""" + repr(act.app_code) + """)
time.sleep(1.0)
pyautogui.press('enter')
time.sleep(1.0)
"""
        else:
            return f"# SwitchApplications not supported on platform: {self.platform}"

    def _open(self, act: Open) -> str:
        """Open an application or file"""
        if self.platform == "Ubuntu":
            # Linux: Win key to open application menu
            return f"""
import pyautogui
import time

pyautogui.press('win')
time.sleep(0.5)
pyautogui.write(""" + repr(act.app_or_filename) + """)
time.sleep(1.0)
pyautogui.hotkey('enter')
time.sleep(0.5)
"""
        elif self.platform == "Windows":
            # Windows: Win+R to open Run dialog
            return f"""
import pyautogui
import time

pyautogui.hotkey('win', 'r', interval=0.1)
time.sleep(0.5)
pyautogui.typewrite(""" + repr(act.app_or_filename) + """)
time.sleep(1.0)
pyautogui.press('enter')
time.sleep(1.0)
"""
        else:
            return f"# Open not supported on platform: {self.platform}"
