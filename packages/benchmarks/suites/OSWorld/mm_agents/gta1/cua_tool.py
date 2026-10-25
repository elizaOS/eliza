tools = [
  {
    "type": "function",
    "function": {
      "name": "click",
      "description": "Click on the element",
      "parameters": {
        "type": "object",
        "properties": {
          "instruction": {
            "type": "string",
            "description": "Decribe the element you want to interact with in detail including the visual description and function description. And make it clear and concise. For example you can describe what the element looks like, and what will be the expected result when you interact with it."
          },
          "num_clicks": {
            "type": "integer",
            "description": "Number of times to click the element.",
            "default": 1
          },
          "button_type": {
            "type": "string",
            "enum": ["left", "middle", "right"],
            "description": "Which mouse button to press.",
            "default": "left"
          },
          "hold_keys": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of keys to hold while clicking",
            "default": []
          }
        },
        "required": ["instruction"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "drag_and_drop",
      "description": "Drag from the starting description to the ending description",
      "parameters": {
        "type": "object",
        "properties": {
          "starting_description": {
            "type": "string",
            "description": "A very detailed description of where to start the drag action. This description should be at least a full sentence. And make it clear and concise."
          },
          "ending_description": {
            "type": "string",
            "description": "A very detailed description of where to end the drag action. This description should be at least a full sentence. And make it clear and concise."
          },
          "hold_keys": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of keys to hold while dragging",
            "default": []
          }
        },
        "required": ["starting_description", "ending_description"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "highlight_text_span",
      "description": "Highlight a text span between a provided starting phrase and ending phrase. Use this to highlight words, lines, and paragraphs.",
      "parameters": {
        "type": "object",
        "properties": {
          "starting_phrase": {
            "type": "string",
            "description": "The phrase that denotes the start of the text span you want to highlight. If you only want to highlight one word, just pass in that single word."
          },
          "ending_phrase": {
            "type": "string",
            "description": "The phrase that denotes the end of the text span you want to highlight. If you only want to highlight one word, just pass in that single word."
          }
        },
        "required": ["starting_phrase", "ending_phrase"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "hold_and_press",
      "description": "Hold a list of keys and press a list of keys",
      "parameters": {
        "type": "object",
        "properties": {
          "hold_keys": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of keys to hold"
          },
          "press_keys": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of keys to press in a sequence"
          }
        },
        "required": ["hold_keys", "press_keys"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "hotkey",
      "description": "Press a hotkey combination",
      "parameters": {
        "type": "object",
        "properties": {
          "keys": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List the keys to press in combination in a list format (e.g. ['ctrl', 'c'])"
          }
        },
        "required": ["keys"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "open",
      "description": "Open any application or file with name app_or_filename. Use this action to open applications or files on the desktop, do not open manually.",
      "parameters": {
        "type": "object",
        "properties": {
          "app_or_filename": {
            "type": "string",
            "description": "The name of the application or filename to open"
          }
        },
        "required": ["app_or_filename"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "scroll",
      "description": "Scroll the element in the specified direction",
      "parameters": {
        "type": "object",
        "properties": {
          "instruction": {
            "type": "string",
            "description": "A very detailed description of which element to enter scroll in. This description should be at least a full sentence. And make it clear and concise."
          },
          "clicks": {
            "type": "integer",
            "description": "The number of clicks to scroll can be positive (up) or negative (down)."
          },
          "shift": {
            "type": "boolean",
            "description": "Whether to use shift+scroll for horizontal scrolling",
            "default": False
          }
        },
        "required": ["instruction", "clicks"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "set_cell_values",
      "description": """Use this to set individual cell values or formulas in a spreadsheet. For setting values: pass {"A2": "hello", "B2": "world"} to set text, or {"A1": 42, "B1": 3.14} for numbers. For setting formulas: start with '=' like {"A2": "=B2+C2", "C1": "=SUM(A1:A10)"}. The sheet must be opened before this command can be used.""",
      "parameters": {
        "type": "object",
        "properties": {
          "cell_values": {
            "type": "object",
            "description": """A dictionary of cell values or formulas to set in the spreadsheet. Keys are cell coordinates like "A1", "B2", etc. Examples: For values: {"A2": "hello", "B1": 42}. For formulas: {"A2": "=B2+C2", "C1": "=SUM(A1:A10)"}. Always start formulas with '='.""",
            "additionalProperties": {
              "type": ["number", "string"]
            },
            "default": {}
          },
          "app_name": {
            "type": "string",
            "description": "Spreadsheet application/file name (e.g., 'Some_sheet.xlsx')."
          },
          "sheet_name": {
            "type": "string",
            "description": "Sheet name (e.g., 'Sheet1')."
          }
        },
        "required": ["cell_values", "app_name", "sheet_name"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "switch_applications",
      "description": "Switch to a different application that is already open",
      "parameters": {
        "type": "object",
        "properties": {
          "app_code": {
            "type": "string",
            "description": "The code/name of the application to switch to from the open apps list."
          }
        },
        "required": ["app_code"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "type",
      "description": "Type text into a specific element",
      "parameters": {
        "type": "object",
        "properties": {
          "element_description": {
            "type": ["string", "null"],
            "description": "Detailed, full-sentence description of the element to type into. If omitted, types into the focused element.",
            "default": None
          },
          "text": {
            "type": "string",
            "description": "The text to type.",
            "default": ""
          },
          "overwrite": {
            "type": "boolean",
            "description": "If true, clear existing text before typing.",
            "default": False
          },
          "enter": {
            "type": "boolean",
            "description": "If true, press Enter after typing.",
            "default": False
          }
        },
        "required": ["text"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "wait",
      "description": "Wait for a specified amount of time",
      "parameters": {
        "type": "object",
        "properties": {
          "time": {
            "type": "number",
            "description": "Time to wait in seconds."
          }
        },
        "required": ["time"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "fast_open_terminal",
      "description": "Save the file in focus, close it, and open a terminal.",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }
  }
]

def to_response_api_tools(completion_tools):
  """
  Convert completion-style tools (nested under the 'function' key)
  into response-style tools (flattened: type/name/description/parameters).

  Example:
  {"type": "function", "function": {"name": "click", ...}}
  ->
  {"type": "function", "name": "click", ...}
  """
  response_tools = []
  for tool in completion_tools or []:
    if isinstance(tool, dict) and tool.get("type") == "function" and isinstance(tool.get("function"), dict):
      fn = tool["function"]
      response_tools.append({
        "type": "function",
        "name": fn.get("name"),
        "description": fn.get("description"),
        "parameters": fn.get("parameters"),
      })
    else:
      response_tools.append(tool)
  return response_tools

response_api_tools = to_response_api_tools(tools)