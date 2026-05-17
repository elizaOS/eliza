# ---------------------------------------------------------------------------
# 2) Android device backend (ADB)
# ---------------------------------------------------------------------------
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
    Screenshot,
    SetCellValues,
    SwitchApplications,
    Open
)

from .Backend import Backend
import time
import subprocess

class ADBBackend(Backend):
    """Android ADB backend for mobile automation."""

    _supported = {Click, DoubleClick, Move, Scroll, Drag, TypeText, Hotkey, Wait, Screenshot, SetCellValues, SwitchApplications, Open}

    def __init__(self, serial: str | None = None):
        self.serial = serial  # specify target device; None = default

    # ------------------------------------------------------------------
    def execute(self, action: Action) -> None:
        if not self.supports(type(action)):
            raise NotImplementedError(f"{type(action).__name__} not supported by ADBBackend")

        if isinstance(action, Click):
            self._click(action)
        elif isinstance(action, DoubleClick):
            self._doubleClick(action)
        elif isinstance(action, Move):
            self._move(action)
        elif isinstance(action, Scroll):
            self._scroll(action)
        elif isinstance(action, Drag):
            self._drag(action)
        elif isinstance(action, TypeText):
            self._type(action)
        elif isinstance(action, Hotkey):
            self._hotkey(action)
        elif isinstance(action, Screenshot):
            return self._screenshot()
        elif isinstance(action, Wait):
            time.sleep(action.duration * 1e-3)
        elif isinstance(action, SetCellValues):
            self._set_cell_values(action)
        elif isinstance(action, SwitchApplications):
            self._switch_applications(action)
        elif isinstance(action, Open):
            self._open(action)
        else:
            raise NotImplementedError(f"Unhandled action: {action}")

    def _click(self, action: Click) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        cmd = prefix + ["input", "tap", str(action.x), str(action.y)]
        subprocess.run(cmd, check=True)

    def _doubleClick(self, action: DoubleClick) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        cmd = prefix + ["input", "doubletap", str(action.x), str(action.y)]
        subprocess.run(cmd, check=True)

    def _move(self, action: Move) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        cmd = prefix + ["input", "move", str(action.x), str(action.y)]
        subprocess.run(cmd, check=True)

    def _scroll(self, action: Scroll) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        # For scroll, we'll use swipe with the x,y coordinates
        # Scroll amount depends on stepVertical/stepHorizontal
        scroll_amount = action.stepVertical or action.stepHorizontal or 3
        if action.stepVertical:
            # Vertical scroll
            end_x, end_y = action.x, action.y - scroll_amount * 100
        else:
            # Horizontal scroll
            end_x, end_y = action.x - scroll_amount * 100, action.y
        
        cmd = prefix + ["input", "swipe", str(action.x), str(action.y), str(end_x), str(end_y), "500"]
        subprocess.run(cmd, check=True)

    def _drag(self, action: Drag) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        cmd = prefix + ["input", "swipe", str(action.startX), str(action.startY), str(action.endX), str(action.endY), "1000"]
        subprocess.run(cmd, check=True)

    def _type(self, action: TypeText) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        text = action.text.replace(" ", "%s")  # escape spaces
        cmd = prefix + ["input", "text", text]
        subprocess.run(cmd, check=True)

    def _hotkey(self, action: Hotkey) -> None:
        prefix = ["adb"]
        if self.serial:
            prefix += ["-s", self.serial]
        prefix.append("shell")
        # Map first key for demo purposes
        key = action.keys[0].upper()
        cmd = prefix + ["input", "keyevent", key]
        subprocess.run(cmd, check=True)

    def _screenshot(self):
        # ADB screenshot implementation
        pass

    def _set_cell_values(self, act: SetCellValues) -> None:
        """Set cell values in mobile spreadsheet apps via ADB"""
        # For mobile apps, we'll use text input to set cell values
        # This is a simplified implementation - in practice, you'd need app-specific logic
        for cell_ref, value in act.cell_values.items():
            # Navigate to cell and set value
            # This would require app-specific implementation
            pass

    def _switch_applications(self, act: SwitchApplications) -> None:
        """Switch to a different Android application via ADB"""
        # Use ADB to switch apps
        import subprocess
        try:
            # Get list of running apps
            result = subprocess.run(['adb', 'shell', 'dumpsys', 'activity', 'activities'], 
                                  capture_output=True, text=True)
            # Parse output to find app and switch to it
            # This is a simplified implementation
            pass
        except subprocess.SubprocessError:
            pass

    def _open(self, act: Open) -> None:
        """Open an Android application via ADB"""
        import subprocess
        try:
            # Use ADB to launch app
            subprocess.run(['adb', 'shell', 'am', 'start', '-n', act.app_or_filename])
        except subprocess.SubprocessError:
            pass
