import base64
import json
import logging
import os
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger("desktopenv.agent")


def agent_action(func):
    func.is_agent_action = True
    return func


switch_window_code = """import subprocess;
import pyautogui;
pyautogui.press('escape');
time.sleep(0.5);
subprocess.run(['wmctrl', '-ia', 'WINDOW_ID'])
subprocess.run(['wmctrl', '-ir', 'WINDOW_ID', '-b', 'add,maximized_vert,maximized_horz'])
print('Switch to WINDOW_ID')"""

launch_app_commands = {
    # Web Browser
    "chrome": "google-chrome --remote-debugging-port=1337",
    # File Manager
    "files": "nautilus",
    # Terminal
    "terminal": 'export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus" && gnome-terminal',
    # Utilities
    "gedit": "gedit",
    # Office
    "libreoffice writer": "libreoffice --writer",
    "libreoffice calc": "libreoffice --calc",
    "libreoffice impress": "libreoffice --impress",
    # System
    "settings": 'export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus" && gnome-control-center',
    # Multimedia
    "vlc": "vlc",
    "gimp": "gimp",
    # IDE
    "vs code": "code",
    # Email
    "thunderbird": "thunderbird",
}


class GroundingAgent:

    tool_list = {
        "libreoffice_calc": "CalcTools",
        "libreoffice_impress": "ImpressTools",
        "libreoffice_writer": "WriterTools",
        "code": "CodeTools",
        "vlc": "VLCTools",
        "google_chrome": "BrowserTools",
    }

    @classmethod
    def tool_commands(cls, code: str, tool_name: str):
        command = f"from {tool_name} import *; "
        command += code

        tool_class = cls.tool_list[tool_name]
        command += f"; {tool_class}.print_result()"

        return [
            command,
        ]

    @classmethod
    @agent_action
    def click(
        cls,
        coordinates: List,
        num_clicks: int = 1,
        button_type: str = "left",
    ):
        """
        Click on the element.

        Args:
            coordinates (List): [x, y], Coordinates of the element to click on
            num_clicks (int): number of times to click the element
            button_type (str): which mouse button to press can be "left", "middle", or "right"
        """
        command = ""
        x, y = coordinates
        command += f"""pyautogui.click({x}, {y}, clicks={num_clicks}, button={repr(button_type)}); print("Click Success")"""  # TODO: 最大化窗口需要一次调用
        return command

    @classmethod
    @agent_action
    def type(
        cls,
        coordinates: Optional[List] = None,
        text: str = "",
        overwrite: bool = False,
        enter: bool = False,
    ):
        """
        Type text into the element.

        Args:
            coordinates (List): [x, y] Coordinates of the element to type into. If not provided, typing will start at the current cursor location.
            text (str): the text to type
            overwrite (bool): Assign it to True if the text should overwrite the existing text, otherwise assign it to False. Using this argument clears all text in an element.
            enter (bool): Assign it to True if the enter key should be pressed after typing the text, otherwise assign it to False.
        """

        command = ""

        if coordinates is not None:
            # Start typing at the center of the element
            x, y = coordinates
            command += f"pyautogui.click({x}, {y}); "

        if overwrite:
            command += f"pyautogui.hotkey('ctrl', 'a'); pyautogui.press('backspace'); "

        command += f"pyautogui.write({repr(text)}); "

        if enter:
            command += "pyautogui.press('enter'); "

        command += "print('Type Success')"

        return command

    @classmethod
    @agent_action
    def drag_and_drop(cls, drag_from_coordinates: List, drop_on_coordinates: List):
        """
        Drag element1 and drop it on element2.

        Args:
            drag_from_coordinates (List): [x, y] Coordinates of element to drag
            drop_on_coordinates (List): [x, y]  Coordinates of element to drop on
        """
        x1, y1 = drag_from_coordinates
        x2, y2 = drop_on_coordinates

        command = f"pyautogui.moveTo({x1}, {y1}); "
        # TODO: specified duration?
        command += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "

        command += "print('Drag and Drop Success')"

        return command

    @classmethod
    @agent_action
    def scroll(cls, coordinates: List, direction: str):
        """
        Scroll the element in the specified direction.

        Args:
            coordinates (List): [x, y] Coordinates of the element to scroll in
            direction (str): the direction to scroll can be "up" or "down".
        """
        x, y = coordinates
        amount = 100 if direction == "up" else -100
        return f"import pyautogui; pyautogui.moveTo({x}, {y}); pyautogui.scroll({amount}); print('Scroll Success')"

    @classmethod
    @agent_action
    def open_app(cls, app_name: str):
        """
        Open a specified application.

        App List:
        - chrome
        - files
        - terminal
        - gedit
        - libreoffice writer
        - libreoffice calc
        - libreoffice impress
        - vs code
        - vlc
        - gimp
        - settings
        - thunderbird

        Args:
            app_name (str): Name of the application to open
        """

        app_name = app_name.lower().strip()

        if app_name not in launch_app_commands:
            command = f"print(f'{app_name} is not supported or recognized')"
        else:
            command = {
                "action_type": "OPEN_APP",
                "parameters": {"launch_app_command": launch_app_commands[app_name], "app_name": app_name},
            }

        return command

    @classmethod
    @agent_action
    def switch_window(cls, window_id: str):
        """
        Switch to the window with the given window id.

        Args:
            window_id (str): the window id to switch to from the provided list of open windows
        """
        return switch_window_code.replace("WINDOW_ID", window_id)

    @classmethod
    @agent_action
    def hotkey(cls, keys: List):
        """
        Press a hotkey combination.

        Args:
            keys (List): the keys to press in combination in a list format (e.g. ['ctrl', 'c'] for copy, ['prtsc'] for screenshot)
        """
        # add quotes around the keys
        keys = [f"'{key}'" for key in keys]
        key_str = ", ".join(keys).replace("'", "\\'")
        return f"import pyautogui; pyautogui.hotkey({', '.join(keys)}); print(f'Press Hotkey: {key_str}')"

    @classmethod
    @agent_action
    def quote(cls, content: str):
        """
        Quoting information from the current page for memory. Only you can see the quoted content.

        Args:
            content (str): text summarized or copied from the page for later operation.
        """
        return f'''print("""{content}""")'''

    @classmethod
    @agent_action
    def wait(cls):
        """
        Wait for a while.

        """
        return "WAIT"

    @classmethod
    @agent_action
    def exit(cls, success: bool):
        """
        End the current task.

        Args:
            success (bool): True if successfully finish a task, otherwise set it False
        """
        if success:
            return "DONE"
        else:
            return "FAIL"
