X_MAX = 1920  # TODO: get the screen resolution
Y_MAX = 1080

KEYBOARD_KEYS = ['\t', '\n', '\r', ' ', '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '{', '|', '}', '~', 'accept', 'add', 'alt', 'altleft', 'altright', 'apps', 'backspace', 'browserback', 'browserfavorites', 'browserforward', 'browserhome', 'browserrefresh', 'browsersearch', 'browserstop', 'capslock', 'clear', 'convert', 'ctrl', 'ctrlleft', 'ctrlright', 'decimal', 'del', 'delete', 'divide', 'down', 'end', 'enter', 'esc', 'escape', 'execute', 'f1', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19', 'f2', 'f20', 'f21', 'f22', 'f23', 'f24', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'final', 'fn', 'hanguel', 'hangul', 'hanja', 'help', 'home', 'insert', 'junja', 'kana', 'kanji', 'launchapp1', 'launchapp2', 'launchmail', 'launchmediaselect', 'left', 'modechange', 'multiply', 'nexttrack', 'nonconvert', 'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'numlock', 'pagedown', 'pageup', 'pause', 'pgdn', 'pgup', 'playpause', 'prevtrack', 'print', 'printscreen', 'prntscrn', 'prtsc', 'prtscr', 'return', 'right', 'scrolllock', 'select', 'separator', 'shift', 'shiftleft', 'shiftright', 'sleep', 'stop', 'subtract', 'tab', 'up', 'volumedown', 'volumemute', 'volumeup', 'win', 'winleft', 'winright', 'yen', 'command', 'option', 'optionleft', 'optionright']

ACTION_SPACE = [
    {
        "action_type": "MOVE_TO",
        "note": "move the cursor to the specified position",
        "parameters": {
            "x": {
                "type": float,
                "range": [0, X_MAX],
                "optional": False,
            },
            "y": {
                "type": float,
                "range": [0, Y_MAX],
                "optional": False,
            }
        }
    },
    {
        "action_type": "CLICK",
        "note": "click the left button if the button not specified, otherwise click the specified button; click at the current position if x and y are not specified, otherwise click at the specified position",
        "parameters": {
            "button": {
                "type": str,
                "range": ["left", "right", "middle"],
                "optional": True,
            },
            "x": {
                "type": float,
                "range": [0, X_MAX],
                "optional": True,
            },
            "y": {
                "type": float,
                "range": [0, Y_MAX],
                "optional": True,
            },
            "num_clicks": {
                "type": int,
                "range": [1, 2, 3],
                "optional": True,
            },
        }
    },
    {
        "action_type": "MOUSE_DOWN",
        "note": "press the left button if the button not specified, otherwise press the specified button",
        "parameters": {
            "button": {
                "type": str,
                "range": ["left", "right", "middle"],
                "optional": True,
            }
        }
    },
    {
        "action_type": "MOUSE_UP",
        "note": "release the left button if the button not specified, otherwise release the specified button",
        "parameters": {
            "button": {
                "type": str,
                "range": ["left", "right", "middle"],
                "optional": True,
            }
        }
    },
    {
        "action_type": "RIGHT_CLICK",
        "note": "right click at the current position if x and y are not specified, otherwise right click at the specified position",
        "parameters": {
            "x": {
                "type": float,
                "range": [0, X_MAX],
                "optional": True,
            },
            "y": {
                "type": float,
                "range": [0, Y_MAX],
                "optional": True,
            }
        }
    },
    {
        "action_type": "DOUBLE_CLICK",
        "note": "double click at the current position if x and y are not specified, otherwise double click at the specified position",
        "parameters": {
            "x": {
                "type": float,
                "range": [0, X_MAX],
                "optional": True,
            },
            "y": {
                "type": float,
                "range": [0, Y_MAX],
                "optional": True,
            }
        }
    },
    {
        "action_type": "DRAG_TO",
        "note": "drag the cursor to the specified position with the left button pressed",
        "parameters": {
            "x": {
                "type": float,
                "range": [0, X_MAX],
                "optional": False,
            },
            "y": {
                "type": float,
                "range": [0, Y_MAX],
                "optional": False,
            }
        }
    },
    {
        "action_type": "SCROLL",
        "note": "scroll the mouse wheel up or down",
        "parameters": {
            "dx": {
                "type": int,
                "range": None,
                "optional": False,
            },
            "dy": {
                "type": int,
                "range": None,
                "optional": False,
            }
        }
    },
    {
        "action_type": "TYPING",
        "note": "type the specified text",
        "parameters": {
            "text": {
                "type": str,
                "range": None,
                "optional": False,
            }
        }
    },
    {
        "action_type": "PRESS",
        "note": "press the specified key and release it",
        "parameters": {
            "key": {
                "type": str,
                "range": KEYBOARD_KEYS,
                "optional": False,
            }
        }
    },
    {
        "action_type": "KEY_DOWN",
        "note": "press the specified key",
        "parameters": {
            "key": {
                "type": str,
                "range": KEYBOARD_KEYS,
                "optional": False,
            }
        }
    },
    {
        "action_type": "KEY_UP",
        "note": "release the specified key",
        "parameters": {
            "key": {
                "type": str,
                "range": KEYBOARD_KEYS,
                "optional": False,
            }
        }
    },
    {
        "action_type": "HOTKEY",
        "note": "press the specified key combination",
        "parameters": {
            "keys": {
                "type": list,
                "range": [KEYBOARD_KEYS],
                "optional": False,
            }
        }
    },
    ############################################################################################################
    {
        "action_type": "WAIT",
        "note": "wait until the next action",
    },
    {
        "action_type": "FAIL",
        "note": "decide the task can not be performed",
    },
    {
        "action_type": "DONE",
        "note": "decide the task is done",
    }
]
