'''
The code is mainly based on:
- Jedi https://github.com/xlang-ai/OSWorld/blob/main/mm_agents/jedi_7b_agent.py
- AgentS2 https://github.com/simular-ai/Agent-S
'''
import base64
import json
import logging
import os
import re
import time
from io import BytesIO

import backoff
import openai
import requests
from PIL import Image
from google.api_core.exceptions import (
    InvalidArgument,
    ResourceExhausted,
    InternalServerError,
    BadRequest,
)
from requests.exceptions import SSLError
import os
from mm_agents.prompts import GTA1_PLANNER_SYSTEM_PROMPT, GTA1_GROUNDING_SYSTEM_PROMPT, GTA1_JUDGE_SYSTEM_PROMPT
from mm_agents.utils.qwen_vl_utils import smart_resize
from pytesseract import Output
import pytesseract
import inspect
import textwrap
import ast
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
from openai import OpenAI, APIConnectionError, APIError, RateLimitError
import cv2

logger = None

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY",None) #"Your OpenAI API Key"
GTA1_API_KEY = os.environ.get("GTA1_API_KEY",None) #"Your GTA1 API Key"
GTA1_MODEL_NMAE = os.environ.get("GTA1_API_KEY",None)  #Your served model name
GTA1_SERVICE_URL = os.environ.get("GTA1_SERVICE_URL",None) #"Your GTA1 Service URL"
proxies = None # Your proxies

MAX_RETRY_TIMES = 20

def encode_image(image_content):
    return base64.b64encode(image_content).decode("utf-8")


class LMMEngineOpenAI:
    '''
    functions borrow from https://github.com/simular-ai/Agent-S/blob/main/gui_agents/s2/core/engine.py#L247
    '''
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model

        api_key = api_key or os.getenv("OPENAI_API_KEY")
        if api_key is None and os.getenv("X_API_KEY") is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named OPENAI_API_KEY"
            )

        self.base_url = base_url

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        if api_key:
            self.llm_client = OpenAI(api_key=self.api_key)
        else:
            self.llm_client = client = OpenAI(base_url=os.getenv("X_API_URL"), api_key="dummy", default_headers = {"X-Api-Key": os.getenv("X_API_KEY")})

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        return (
            self.llm_client.chat.completions.create(
                model=self.model,
                messages=messages,
                max_completion_tokens=max_new_tokens if max_new_tokens else 4096,
                #temperature=temperature,
                **kwargs,
            )
            .choices[0]
            .message.content
        )

class LMMAgent:
    '''
    functions borrow from https://github.com/simular-ai/Agent-S/blob/a0c5c9bf0c526119b1f023c8948563c780729428/gui_agents/s2/core/mllm.py#L16
    '''
    def __init__(self, engine_params=None, system_prompt=None, engine=None):
        if engine is None:
            if engine_params is not None:
                engine_type = engine_params.get("engine_type")
                if engine_type == "openai":
                    self.engine = LMMEngineOpenAI(**engine_params)
                else:
                    raise ValueError("engine_type is not supported")
            else:
                raise ValueError("engine_params must be provided")
        else:
            self.engine = engine

        self.messages = []

        if system_prompt:
            self.add_system_prompt(system_prompt)
        else:
            self.add_system_prompt("You are a helpful assistant.")

    def encode_image(self, image_content):
        # if image_content is a path to an image file, check type of the image_content to verify
        if isinstance(image_content, str):
            with open(image_content, "rb") as image_file:
                return base64.b64encode(image_file.read()).decode("utf-8")
        else:
            return base64.b64encode(image_content).decode("utf-8")

    def reset(
        self,
    ):

        self.messages = [
            {
                "role": "system",
                "content": [{"type": "text", "text": self.system_prompt}],
            }
        ]

    def add_system_prompt(self, system_prompt):
        self.system_prompt = system_prompt
        if len(self.messages) > 0:
            self.messages[0] = {
                "role": "system",
                "content": [{"type": "text", "text": self.system_prompt}],
            }
        else:
            self.messages.append(
                {
                    "role": "system",
                    "content": [{"type": "text", "text": self.system_prompt}],
                }
            )

    def remove_message_at(self, index):
        """Remove a message at a given index"""
        if index < len(self.messages):
            self.messages.pop(index)

    def replace_message_at(
        self, index, text_content, image_content=None, image_detail="high"
    ):
        """Replace a message at a given index"""
        if index < len(self.messages):
            self.messages[index] = {
                "role": self.messages[index]["role"],
                "content": [{"type": "text", "text": text_content}],
            }
            if image_content:
                base64_image = self.encode_image(image_content)
                self.messages[index]["content"].append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{base64_image}",
                            "detail": image_detail,
                        },
                    }
                )

    def add_message(
        self,
        text_content,
        image_content=None,
        role=None,
        image_detail="high",
        put_text_last=False,
    ):
        """Add a new message to the list of messages"""

        # API-style inference from OpenAI and AzureOpenAI
        if isinstance(
            self.engine,
            (
                LMMEngineOpenAI,
            ),
        ):
            # infer role from previous message
            if role != "user":
                if self.messages[-1]["role"] == "system":
                    role = "user"
                elif self.messages[-1]["role"] == "user":
                    role = "assistant"
                elif self.messages[-1]["role"] == "assistant":
                    role = "user"

            message = {
                "role": role,
                "content": [{"type": "text", "text": text_content}],
            }

            if isinstance(image_content, np.ndarray) or image_content:
                # Check if image_content is a list or a single image
                if isinstance(image_content, list):
                    # If image_content is a list of images, loop through each image
                    for image in image_content:
                        base64_image = self.encode_image(image)
                        message["content"].append(
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{base64_image}",
                                    "detail": image_detail,
                                },
                            }
                        )
                else:
                    # If image_content is a single image, handle it directly
                    base64_image = self.encode_image(image_content)
                    message["content"].append(
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{base64_image}",
                                "detail": image_detail,
                            },
                        }
                    )

            # Rotate text to be the last message if desired
            if put_text_last:
                text_content = message["content"].pop(0)
                message["content"].append(text_content)

            self.messages.append(message)
        else:
            raise ValueError("engine_type is not supported")

    def get_response(
        self,
        user_message=None,
        messages=None,
        temperature=0.0,
        max_new_tokens=None,
        **kwargs,
    ):
        """Generate the next response based on previous messages"""
        if messages is None:
            messages = self.messages
        if user_message:
            messages.append(
                {"role": "user", "content": [{"type": "text", "text": user_message}]}
            )

        return self.engine.generate(
            messages,
            temperature=temperature,
            max_new_tokens=max_new_tokens,
            **kwargs,
        )
        
def agent_action(func):
    func.is_agent_action = True
    return func


UBUNTU_APP_SETUP = f"""import subprocess;
import difflib;
import pyautogui;
pyautogui.press('escape');
time.sleep(0.5);
output = subprocess.check_output(['wmctrl', '-lx']);
output = output.decode('utf-8').splitlines();
window_titles = [line.split(None, 4)[2] for line in output];
closest_matches = difflib.get_close_matches('APP_NAME', window_titles, n=1, cutoff=0.1);
if closest_matches:
    closest_match = closest_matches[0];
    for line in output:
        if closest_match in line:
            window_id = line.split()[0]
            break;
subprocess.run(['wmctrl', '-ia', window_id])
subprocess.run(['wmctrl', '-ir', window_id, '-b', 'add,maximized_vert,maximized_horz'])
"""


SET_CELL_VALUES_CMD = """import uno
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
    subprocess.run(
        'echo \"password\" | sudo -S ss --kill --tcp state TIME-WAIT sport = :2002',
        shell=True,
        check=True,
        text=True,
        capture_output=True
    )

    # Dynamically allow soffice to listen on port 2002.
    subprocess.run(
        [
            "soffice",
            "--accept=socket,host=localhost,port=2002;urp;StarOffice.Service"
        ]
    )

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

set_cell_values(new_cell_values={cell_values}, app_name="{app_name}", sheet_name="{sheet_name}")        
"""

    
class OSWorldACI:
    '''
    classes borrow from https://github.com/simular-ai/Agent-S/blob/a0c5c9bf0c526119b1f023c8948563c780729428/gui_agents/s2/agents/grounding.py#L159
    '''
    PHRASE_TO_WORD_COORDS_PROMPT = textwrap.dedent(
        """
    You are an expert in graphical user interfaces. Your task is to process a phrase of text, and identify the most relevant word on the computer screen.
    You are provided with a phrase, a table with all the text on the screen, and a screenshot of the computer screen. You will identify the single word id that is best associated with the provided phrase.
    This single word must be displayed on the computer screenshot, and its location on the screen should align with the provided phrase.
    Each row in the text table provides 2 pieces of data in the following order. 1st is the unique word id. 2nd is the corresponding word.

    To be successful, it is very important to follow all these rules:
    1. First, think step by step and generate your reasoning about which word id to click on.
    2. Then, output the unique word id. Remember, the word id is the 1st number in each row of the text table.
    3. If there are multiple occurrences of the same word, use the surrounding context in the phrase to choose the correct one. Pay very close attention to punctuation and capitalization.

    """
    )
    def __init__(
        self,
        platform: 'linux',
        width: int = 1920,
        height: int = 1080,
        model: str = "o3",
    ):
        self.platform = (
            platform  # Dictates how the switch_applications agent action works.
        )
        
        engine_params_for_generation = engine_params = {
            "engine_type": 'openai',
            "model": model,
            "base_url": '',
            "api_key": os.environ.get("OPENAI_API_KEY", ""),
        }
        
        # Configure scaling
        self.width = width
        self.height = height

        # Maintain state for save_to_knowledge
        self.notes = []

        # Coordinates used during ACI execution
        self.coords1 = None
        self.coords2 = None

        # Configure text grounding agent
        self.text_span_agent = LMMAgent(
            engine_params=engine_params_for_generation,
            system_prompt=self.PHRASE_TO_WORD_COORDS_PROMPT,
        )
        
        self.dummy_agent = DummyAgent(platform=platform)

    # Given the state and worker's referring expression, use the grounding model to generate (x,y)
    def generate_coords(self, ref_expr: str, obs: Dict, request_vllm) -> List[int]:
        return request_vllm(image=obs["screenshot"], prompt=ref_expr)

    # Calls pytesseract to generate word level bounding boxes for text grounding
    def get_ocr_elements(self, b64_image_data: str) -> Tuple[str, List]:
        image = Image.open(BytesIO(b64_image_data))
        image_data = pytesseract.image_to_data(image, output_type=Output.DICT)

        # Clean text by removing leading and trailing spaces and non-alphabetical characters, but keeping punctuation
        for i, word in enumerate(image_data["text"]):
            image_data["text"][i] = re.sub(
                r"^[^a-zA-Z\s.,!?;:\-\+]+|[^a-zA-Z\s.,!?;:\-\+]+$", "", word
            )
        ocr_elements = []
        ocr_table = "Text Table:\nWord id\tText\n"
        # Obtain the <id, text, group number, word number> for each valid element
        grouping_map = defaultdict(list)
        ocr_id = 0
        for i in range(len(image_data["text"])):
            block_num = image_data["block_num"][i]
            if image_data["text"][i]:
                grouping_map[block_num].append(image_data["text"][i])
                ocr_table += f"{ocr_id}\t{image_data['text'][i]}\n"
                ocr_elements.append(
                    {
                        "id": ocr_id,
                        "text": image_data["text"][i],
                        "group_num": block_num,
                        "word_num": len(grouping_map[block_num]),
                        "left": image_data["left"][i],
                        "top": image_data["top"][i],
                        "width": image_data["width"][i],
                        "height": image_data["height"][i],
                    }
                )
                ocr_id += 1

        return ocr_table, ocr_elements

    # Given the state and worker's text phrase, generate the coords of the first/last word in the phrase
    def generate_text_coords(
        self, phrase: str, obs: Dict, alignment: str = ""
    ) -> List[int]:
        ocr_table, ocr_elements = self.get_ocr_elements(obs["screenshot"])

        alignment_prompt = ""
        if alignment == "start":
            alignment_prompt = "**Important**: Output the word id of the FIRST word in the provided phrase.\n"
        elif alignment == "end":
            alignment_prompt = "**Important**: Output the word id of the LAST word in the provided phrase.\n"
            
        # Load LLM prompt
        self.text_span_agent.reset()
        self.text_span_agent.add_message(
            alignment_prompt + "Phrase: " + phrase + "\n" + ocr_table, role="user"
        )
        self.text_span_agent.add_message(
            "Screenshot:\n", image_content=obs["screenshot"], role="user"
        )

        # Obtain the target element
        response = call_llm_safe(self.text_span_agent)
        #print("TEXT SPAN AGENT RESPONSE:", response)
        numericals = re.findall(r"\d+", response)
        if len(numericals) > 0:
            text_id = int(numericals[-1])
        else:
            text_id = 0
        elem = ocr_elements[text_id]

        # Compute the element coordinates
        if alignment == "start":
            coords = [elem["left"], elem["top"] + (elem["height"] // 2)]
        elif alignment == "end":
            coords = [elem["left"] + elem["width"], elem["top"] + (elem["height"] // 2)]
        else:
            coords = [
                elem["left"] + (elem["width"] // 2),
                elem["top"] + (elem["height"] // 2),
            ]
        return coords

    # Takes a description based action and assigns the coordinates for any coordinate based action
    # Raises an error if function can't be parsed
    def assign_coordinates(self, plan: str, obs: Dict, request_vllm):

        # Reset coords from previous action generation
        self.coords1, self.coords2 = None, None

        try:
            # Extract the function name and args
            action = parse_single_code_from_string(plan.split("Grounded Action")[-1])
            function_name = re.match(r"(\w+\.\w+)\(", action).group(1)
            args = self.parse_function_args(action)
        except Exception as e:
            raise RuntimeError(f"Error in parsing grounded action: {e}") from e

        # arg0 is a description
        if (
            function_name in ["agent.click", "agent.type", "agent.scroll"]
            and len(args) >= 1
            and args[0] != None
        ):
            self.coords1 = self.generate_coords(args[0], obs, request_vllm)
        # arg0 and arg1 are descriptions
        elif function_name == "agent.drag_and_drop" and len(args) >= 2:
            self.coords1 = self.generate_coords(args[0], obs, request_vllm)
            self.coords2 = self.generate_coords(args[1], obs, request_vllm)
        # arg0 and arg1 are text phrases
        elif function_name == "agent.highlight_text_span" and len(args) >= 2:
            self.coords1 = self.generate_text_coords(args[0], obs, alignment="start")
            self.coords2 = self.generate_text_coords(args[1], obs, alignment="end")

    # Resize from grounding model dim into OSWorld dim (1920 * 1080)
    def resize_coordinates(self, coordinates: List[int]) -> List[int]:
        return [
            round(coordinates[0] * self.width),
            round(coordinates[1] * self.height),
        ]

    # Given a generated ACI function, returns a list of argument values, where descriptions are at the front of the list
    def parse_function_args(self, function: str) -> List[str]:
        tree = ast.parse(function)
        call_node = tree.body[0].value

        def safe_eval(node):
            if isinstance(
                node, ast.Constant
            ):  # Handles literals like numbers, strings, etc.
                return node.value
            else:
                return ast.unparse(node)  # Return as a string if not a literal

        positional_args = [safe_eval(arg) for arg in call_node.args]
        keyword_args = {kw.arg: safe_eval(kw.value) for kw in call_node.keywords}

        res = []

        for key, val in keyword_args.items():
            if "description" in key:
                res.append(val)

        for arg in positional_args:
            res.append(arg)

        return res

    def click(
        self,
        instruction: str,
        num_clicks: int = 1,
        button_type: str = "left",
        hold_keys: List = [],
    ):
        """Click on the element
        Args:
            instruction:str, decribe the element you want to interact with in detail including the visual description and function description. And make it clear and concise. For example you can describe what the element looks like, and what will be the expected result when you interact with it.
            num_clicks:int, number of times to click the element
            button_type:str, which mouse button to press can be "left", "middle", or "right"
            hold_keys:List, list of keys to hold while clicking
        """
        x, y = self.resize_coordinates(self.coords1)
        command = "import pyautogui; "

        # TODO: specified duration?
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"""import pyautogui; pyautogui.click({x}, {y}, clicks={num_clicks}, button={repr(button_type)}); """
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "
        # Return pyautoguicode to click on the element
        return command

    def switch_applications(self, app_code):
        """Switch to a different application that is already open
        Args:
            app_code:str the code name of the application to switch to from the provided list of open applications
        """
        if self.platform == "darwin":
            return f"import pyautogui; import time; pyautogui.hotkey('command', 'space', interval=0.5); pyautogui.typewrite({repr(app_code)}); pyautogui.press('enter'); time.sleep(1.0)"
        elif self.platform == "linux":
            return UBUNTU_APP_SETUP.replace("APP_NAME", app_code)
        elif self.platform == "windows":
            return f"import pyautogui; import time; pyautogui.hotkey('win', 'd', interval=0.5); pyautogui.typewrite({repr(app_code)}); pyautogui.press('enter'); time.sleep(1.0)"

    def open(self, app_or_filename: str):
        """Open any application or file with name app_or_filename. Use this action to open applications or files on the desktop, do not open manually.
        Args:
            app_or_filename:str, the name of the application or filename to open
        """
        return f"import pyautogui; pyautogui.hotkey('win'); time.sleep(0.5); pyautogui.write({repr(app_or_filename)}); time.sleep(1.0); pyautogui.hotkey('enter'); time.sleep(0.5)"

    def type(
        self,
        element_description: Optional[str] = None,
        text: str = "",
        overwrite: bool = False,
        enter: bool = False,
    ):
        """Type text into a specific element
        Args:
            element_description:str, a detailed description of which element to enter text in. This description should be at least a full sentence.
            text:str, the text to type
            overwrite:bool, Assign it to True if the text should overwrite the existing text, otherwise assign it to False. Using this argument clears all text in an element.
            enter:bool, Assign it to True if the enter key should be pressed after typing the text, otherwise assign it to False.
        """

        if self.coords1 is not None:
            # If a node is found, retrieve its coordinates and size
            # Start typing at the center of the element

            x, y = self.resize_coordinates(self.coords1)

            command = "import pyautogui; "
            command += f"pyautogui.click({x}, {y}); "

            if overwrite:
                command += (
                    f"pyautogui.hotkey('ctrl', 'a'); pyautogui.press('backspace'); "
                )

            command += f"pyautogui.write({repr(text)}); "

            if enter:
                command += "pyautogui.press('enter'); "
        else:
            # If no element is found, start typing at the current cursor location
            command = "import pyautogui; "

            if overwrite:
                command += (
                    f"pyautogui.hotkey('ctrl', 'a'); pyautogui.press('backspace'); "
                )

            command += f"pyautogui.write({repr(text)}); "

            if enter:
                command += "pyautogui.press('enter'); "

        return command

    def drag_and_drop(
        self, starting_description: str, ending_description: str, hold_keys: List = []
    ):
        """Drag from the starting description to the ending description
        Args:
            starting_description:str, a very detailed description of where to start the drag action. This description should be at least a full sentence. And make it clear and concise.
            ending_description:str, a very detailed description of where to end the drag action. This description should be at least a full sentence. And make it clear and concise.
            hold_keys:List list of keys to hold while dragging
        """
        x1, y1 = self.resize_coordinates(self.coords1)
        x2, y2 = self.resize_coordinates(self.coords2)

        command = "import pyautogui; "

        command += f"pyautogui.moveTo({x1}, {y1}); "
        # TODO: specified duration?
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "

        # Return pyautoguicode to drag and drop the elements

        return command

    def highlight_text_span(self, starting_phrase: str, ending_phrase: str):
        """Highlight a text span between a provided starting phrase and ending phrase. Use this to highlight words, lines, and paragraphs.
        Args:
            starting_phrase:str, the phrase that denotes the start of the text span you want to highlight. If you only want to highlight one word, just pass in that single word.
            ending_phrase:str, the phrase that denotes the end of the text span you want to highlight. If you only want to highlight one word, just pass in that single word.
        """

        x1, y1 = self.coords1
        x2, y2 = self.coords2

        command = "import pyautogui; "
        command += f"pyautogui.moveTo({x1}, {y1}); "
        command += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "

        # Return pyautoguicode to drag and drop the elements
        return command

    def set_cell_values(
        self, cell_values: Dict[str, Any], app_name: str, sheet_name: str
    ):
        """Use this to set individual cell values in a spreadsheet. For example, setting A2 to "hello" would be done by passing {"A2": "hello"} as cell_values. The sheet must be opened before this command can be used.
        Args:
            cell_values: Dict[str, Any], A dictionary of cell values to set in the spreadsheet. The keys are the cell coordinates in the format "A1", "B2", etc.
                Supported value types include: float, int, string, bool, formulas.
            app_name: str, The name of the spreadsheet application. For example, "Some_sheet.xlsx".
            sheet_name: str, The name of the sheet in the spreadsheet. For example, "Sheet1".
        """
        return SET_CELL_VALUES_CMD.format(
            cell_values=cell_values, app_name=app_name, sheet_name=sheet_name
        )

    def scroll(self, instruction: str, clicks: int, shift: bool = False):
        """Scroll the element in the specified direction
        Args:
            instruction:str, a very detailed description of which element to enter scroll in. This description should be at least a full sentence. And make it clear and concise.
            clicks:int, the number of clicks to scroll can be positive (up) or negative (down).
            shift:bool, whether to use shift+scroll for horizontal scrolling
        """

        x, y = self.resize_coordinates(self.coords1)

        if shift:
            return f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.hscroll({clicks})"
        else:
            return f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.vscroll({clicks})"

    def hotkey(self, keys: List):
        """Press a hotkey combination
        Args:
            keys:List the keys to press in combination in a list format (e.g. ['ctrl', 'c'])
        """
        # add quotes around the keys
        keys = [f"'{key}'" for key in keys]
        return f"import pyautogui; pyautogui.hotkey({', '.join(keys)})"

    def hold_and_press(self, hold_keys: List, press_keys: List):
        """Hold a list of keys and press a list of keys
        Args:
            hold_keys:List, list of keys to hold
            press_keys:List, list of keys to press in a sequence
        """

        press_keys_str = "[" + ", ".join([f"'{key}'" for key in press_keys]) + "]"
        command = "import pyautogui; "
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"pyautogui.press({press_keys_str}); "
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "

        return command

    def wait(self, time: float):
        """Wait for a specified amount of time
        Args:
            time:float the amount of time to wait in seconds
        """
        return f"""import time; time.sleep({time})"""

    def done(
        self,
        return_value: Optional[Union[Dict, str, List, Tuple, int, float, bool]] = None,
    ):
        """End the current task with a success and the required return value"""
        self.returned_info = return_value
        return """DONE"""

    def fail(self):
        """End the current task with a failure, and replan the whole task."""
        return """FAIL"""

class DummyAgent:
    def __init__(
        self,
        platform,
    ):
        self.platform = (
            platform  # Dictates how the switch_applications agent action works.
        )
        
        self.width = 1
        self.height = 1

        self.notes = []

        self.coords1 = None
        self.coords2 = None

    def generate_coords(self, ref_expr: str, obs: Dict) -> List[int]:
        return 0,0

    def generate_text_coords(
        self, phrase: str, obs: Dict, alignment: str = ""
    ) -> List[int]:
        return 0,0

    # Takes a description based action and assigns the coordinates for any coordinate based action
    # Raises an error if function can't be parsed
    def assign_coordinates(self, plan: str, obs: Dict):

        # Reset coords from previous action generation
        self.coords1, self.coords2 = None, None

        try:
            # Extract the function name and args
            action = parse_single_code_from_string(plan.split("Grounded Action")[-1])
            function_name = re.match(r"(\w+\.\w+)\(", action).group(1)
            args = self.parse_function_args(action)
        except Exception as e:
            raise RuntimeError(f"Error in parsing grounded action: {e}") from e

        # arg0 is a description
        if (
            function_name in ["agent.click", "agent.type", "agent.scroll"]
            and len(args) >= 1
            and args[0] != None
        ):
            self.coords1 = self.generate_coords(args[0], obs)
        # arg0 and arg1 are descriptions
        elif function_name == "agent.drag_and_drop" and len(args) >= 2:
            self.coords1 = self.generate_coords(args[0], obs)
            self.coords2 = self.generate_coords(args[1], obs)
        # arg0 and arg1 are text phrases
        elif function_name == "agent.highlight_text_span" and len(args) >= 2:
            self.coords1 = self.generate_text_coords(args[0], obs, alignment="start")
            self.coords2 = self.generate_text_coords(args[1], obs, alignment="end")

    # Resize from grounding model dim into OSWorld dim (1920 * 1080)
    def resize_coordinates(self, coordinates: List[int]) -> List[int]:
        return [
            round(coordinates[0] * self.width),
            round(coordinates[1] * self.height),
        ]

    # Given a generated ACI function, returns a list of argument values, where descriptions are at the front of the list
    def parse_function_args(self, function: str) -> List[str]:
        tree = ast.parse(function)
        call_node = tree.body[0].value

        def safe_eval(node):
            if isinstance(
                node, ast.Constant
            ):  # Handles literals like numbers, strings, etc.
                return node.value
            else:
                return ast.unparse(node)  # Return as a string if not a literal

        positional_args = [safe_eval(arg) for arg in call_node.args]
        keyword_args = {kw.arg: safe_eval(kw.value) for kw in call_node.keywords}

        res = []

        for key, val in keyword_args.items():
            if "description" in key:
                res.append(val)

        for arg in positional_args:
            res.append(arg)

        return res
    
    def click(
        self,
        instruction: str,
        num_clicks: int = 1,
        button_type: str = "left",
        hold_keys: List = [],
    ):
        """Click on the element
        Args:
            instruction:str, decribe the element you want to interact with in detail including the visual description and function description. And make it clear and concise. For example you can describe what the element looks like, and what will be the expected result when you interact with it.
            num_clicks:int, number of times to click the element
            button_type:str, which mouse button to press can be "left", "middle", or "right"
            hold_keys:List, list of keys to hold while clicking
        """
        x, y = self.resize_coordinates(self.coords1)
        command = "import pyautogui; "

        # TODO: specified duration?
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"""import pyautogui; pyautogui.click({x}, {y}, clicks={num_clicks}, button={repr(button_type)}); """
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "
        # Return pyautoguicode to click on the element
        return command

    def switch_applications(self, app_code):
        """Switch to a different application that is already open
        Args:
            app_code:str the code name of the application to switch to from the provided list of open applications
        """
        if self.platform == "darwin":
            return f"import pyautogui; import time; pyautogui.hotkey('command', 'space', interval=0.5); pyautogui.typewrite({repr(app_code)}); pyautogui.press('enter'); time.sleep(1.0)"
        elif self.platform == "linux":
            return UBUNTU_APP_SETUP.replace("APP_NAME", app_code)
        elif self.platform == "windows":
            return f"import pyautogui; import time; pyautogui.hotkey('win', 'd', interval=0.5); pyautogui.typewrite({repr(app_code)}); pyautogui.press('enter'); time.sleep(1.0)"

    def open(self, app_or_filename: str):
        """Open any application or file with name app_or_filename. Use this action to open applications or files on the desktop, do not open manually.
        Args:
            app_or_filename:str, the name of the application or filename to open
        """
        return f"import pyautogui; pyautogui.hotkey('win'); time.sleep(0.5); pyautogui.write({repr(app_or_filename)}); time.sleep(1.0); pyautogui.hotkey('enter'); time.sleep(0.5)"

    def type(
        self,
        element_description: Optional[str] = None,
        text: str = "",
        overwrite: bool = False,
        enter: bool = False,
    ):
        """Type text into a specific element
        Args:
            element_description:str, a detailed description of which element to enter text in. This description should be at least a full sentence.
            text:str, the text to type
            overwrite:bool, Assign it to True if the text should overwrite the existing text, otherwise assign it to False. Using this argument clears all text in an element.
            enter:bool, Assign it to True if the enter key should be pressed after typing the text, otherwise assign it to False.
        """

        if self.coords1 is not None:
            # If a node is found, retrieve its coordinates and size
            # Start typing at the center of the element

            x, y = self.resize_coordinates(self.coords1)

            command = "import pyautogui; "
            command += f"pyautogui.click({x}, {y}); "

            if overwrite:
                command += (
                    f"pyautogui.hotkey('ctrl', 'a'); pyautogui.press('backspace'); "
                )

            command += f"pyautogui.write({repr(text)}); "

            if enter:
                command += "pyautogui.press('enter'); "
        else:
            # If no element is found, start typing at the current cursor location
            command = "import pyautogui; "

            if overwrite:
                command += (
                    f"pyautogui.hotkey('ctrl', 'a'); pyautogui.press('backspace'); "
                )

            command += f"pyautogui.write({repr(text)}); "

            if enter:
                command += "pyautogui.press('enter'); "

        return command

    def drag_and_drop(
        self, starting_description: str, ending_description: str, hold_keys: List = []
    ):
        """Drag from the starting description to the ending description
        Args:
            starting_description:str, a very detailed description of where to start the drag action. This description should be at least a full sentence. And make it clear and concise.
            ending_description:str, a very detailed description of where to end the drag action. This description should be at least a full sentence. And make it clear and concise.
            hold_keys:List list of keys to hold while dragging
        """
        x1, y1 = self.resize_coordinates(self.coords1)
        x2, y2 = self.resize_coordinates(self.coords2)

        command = "import pyautogui; "

        command += f"pyautogui.moveTo({x1}, {y1}); "
        # TODO: specified duration?
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "

        # Return pyautoguicode to drag and drop the elements

        return command

    def highlight_text_span(self, starting_phrase: str, ending_phrase: str):
        """Highlight a text span between a provided starting phrase and ending phrase. Use this to highlight words, lines, and paragraphs.
        Args:
            starting_phrase:str, the phrase that denotes the start of the text span you want to highlight. If you only want to highlight one word, just pass in that single word.
            ending_phrase:str, the phrase that denotes the end of the text span you want to highlight. If you only want to highlight one word, just pass in that single word.
        """

        x1, y1 = self.coords1
        x2, y2 = self.coords2

        command = "import pyautogui; "
        command += f"pyautogui.moveTo({x1}, {y1}); "
        command += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "

        # Return pyautoguicode to drag and drop the elements
        return command

    def set_cell_values(
        self, cell_values: Dict[str, Any], app_name: str, sheet_name: str
    ):
        """Use this to set individual cell values in a spreadsheet. For example, setting A2 to "hello" would be done by passing {"A2": "hello"} as cell_values. The sheet must be opened before this command can be used.
        Args:
            cell_values: Dict[str, Any], A dictionary of cell values to set in the spreadsheet. The keys are the cell coordinates in the format "A1", "B2", etc.
                Supported value types include: float, int, string, bool, formulas.
            app_name: str, The name of the spreadsheet application. For example, "Some_sheet.xlsx".
            sheet_name: str, The name of the sheet in the spreadsheet. For example, "Sheet1".
        """
        return SET_CELL_VALUES_CMD.format(
            cell_values=cell_values, app_name=app_name, sheet_name=sheet_name
        )

    def scroll(self, instruction: str, clicks: int, shift: bool = False):
        """Scroll the element in the specified direction
        Args:
            instruction:str, a very detailed description of which element to enter scroll in. This description should be at least a full sentence. And make it clear and concise.
            clicks:int, the number of clicks to scroll can be positive (up) or negative (down).
            shift:bool, whether to use shift+scroll for horizontal scrolling
        """

        x, y = self.resize_coordinates(self.coords1)

        if shift:
            return f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.hscroll({clicks})"
        else:
            return f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.vscroll({clicks})"

    def hotkey(self, keys: List):
        """Press a hotkey combination
        Args:
            keys:List the keys to press in combination in a list format (e.g. ['ctrl', 'c'])
        """
        # add quotes around the keys
        keys = [f"'{key}'" for key in keys]
        return f"import pyautogui; pyautogui.hotkey({', '.join(keys)})"

    def hold_and_press(self, hold_keys: List, press_keys: List):
        """Hold a list of keys and press a list of keys
        Args:
            hold_keys:List, list of keys to hold
            press_keys:List, list of keys to press in a sequence
        """

        press_keys_str = "[" + ", ".join([f"'{key}'" for key in press_keys]) + "]"
        command = "import pyautogui; "
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"pyautogui.press({press_keys_str}); "
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "

        return command

    def wait(self, time: float):
        """Wait for a specified amount of time
        Args:
            time:float the amount of time to wait in seconds
        """
        return f"""import time; time.sleep({time})"""

    def done(
        self,
        return_value: Optional[Union[Dict, str, List, Tuple, int, float, bool]] = None,
    ):
        """End the current task with a success and the required return value"""
        self.returned_info = return_value
        return """DONE"""

    def fail(self):
        """End the current task with a failure, and replan the whole task."""
        return """FAIL"""
    
    def run_python(self,code):
        return code
    
    def fast_open_terminal(self, *args,**kwargs):
        app_or_filename='terminal'
        return f"import time; import pyautogui; pyautogui.hotkey('ctrl', 's'); time.sleep(0.5); pyautogui.hotkey('alt', 'f4'); time.sleep(0.5); pyautogui.hotkey('win'); time.sleep(0.5); pyautogui.write({repr(app_or_filename)}); time.sleep(1.0); pyautogui.hotkey('enter'); time.sleep(0.5)"

def call_llm_safe(agent):
    '''
    functions borrow from https://github.com/simular-ai/Agent-S/blob/a0c5c9bf0c526119b1f023c8948563c780729428/gui_agents/s2/utils/common_utils.py#L27 
    '''
    # Retry if fails
    attempt = 0
    response = ""
    while attempt < MAX_RETRY_TIMES:
        try:
            response = agent.get_response()
            break  # If successful, break out of the loop
        except Exception as e:
            attempt += 1
            print(f"Attempt {attempt} failed: {e}")
            if attempt == MAX_RETRY_TIMES:
                print("Max retries reached. Handling failure.")
        time.sleep(1.0)
    return response

def parse_single_code_from_string(input_string):
    '''
    functions borrow from https://github.com/simular-ai/Agent-S/blob/a0c5c9bf0c526119b1f023c8948563c780729428/gui_agents/s2/utils/common_utils.py#L129
    '''
    input_string = input_string.strip()
    if input_string.strip() in ["WAIT", "DONE", "FAIL"]:
        return input_string.strip()

    # This regular expression will match both ```code``` and ```python code```
    # and capture the `code` part. It uses a non-greedy match for the content inside.
    pattern = r"```(?:\w+\s+)?(.*?)```"
    # Find all non-overlapping matches in the string
    matches = re.findall(pattern, input_string, re.DOTALL)

    # The regex above captures the content inside the triple backticks.
    # The `re.DOTALL` flag allows the dot `.` to match newline characters as well,
    # so the code inside backticks can span multiple lines.

    # matches now contains all the captured code snippets

    codes = []

    for match in matches:
        match = match.strip()
        commands = [
            "WAIT",
            "DONE",
            "FAIL",
        ]  # fixme: updates this part when we have more commands

        if match in commands:
            codes.append(match.strip())
        elif match.split("\n")[-1] in commands:
            if len(match.split("\n")) > 1:
                codes.append("\n".join(match.split("\n")[:-1]))
            codes.append(match.split("\n")[-1])
        else:
            codes.append(match)

    return codes[0]

agent = OSWorldACI('linux')

class GTA1Agent:
    '''
    class based on https://github.com/xlang-ai/OSWorld/blob/main/mm_agents/jedi_7b_agent.py
    '''
    def __init__(
        self,
        platform="ubuntu",
        planner_model="o3",
        max_tokens=4096,
        top_p=0.9,
        temperature= 0.0,
        action_space="pyautogui",
        observation_type="screenshot",
        max_steps=100,
        max_image_history_length = 5,
        N_SEQ = 8,
        client_password="password"
    ):
        self.platform = platform
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.client_password = client_password
        self.action_space = action_space
        self.observation_type = observation_type
        assert action_space in ["pyautogui"], "Invalid action space"
        assert observation_type in ["screenshot"], "Invalid observation type"
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.observation_captions = []
        self.max_steps = max_steps
        self.planner_model=planner_model
        self.current_step = 1
        self.max_image_history_length = max_image_history_length
        self.N_SEQ=N_SEQ

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Predict the next action(s) based on the current observation.
        """

        user_prompt = (
            f"""Please generate the next move according to the UI screenshot and instruction. And you can refer to the previous actions and observations for reflection.\n\nInstruction: {instruction}\n\n""")

        system_prompt = GTA1_PLANNER_SYSTEM_PROMPT

        messages = [{
            "role": "system",
            "content": [{
                "type": "text",
                "text": system_prompt.replace("{current_step}", str(self.current_step)).replace("{max_steps}", str(self.max_steps))
            }]
        }]

        # Determine which observations to include images for (only most recent ones)
        obs_start_idx = max(0, len(self.observations) - self.max_image_history_length)
        
        # Add all thought and action history
        for i in range(len(self.thoughts)):
            # For recent steps, include the actual screenshot
            if i >= obs_start_idx:
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{encode_image(self.observations[i]['screenshot'])}",
                            "detail": "high"
                        },
                    }]
                })
                
            messages.append({
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": f"Step {i+1} Observation:\n{self.observation_captions[i]}\n"
                    }]
                })

            thought_messages = f"Step {i+1} Thought:\n{self.thoughts[i]}"

            action_messages = f"Step {i+1} Action:"
            for action in self.actions[i]:
                action_messages += f"\n{action}"
            messages.append({
                    "role": "assistant",
                    "content": [{
                        "type": "text",
                        "text": thought_messages + "\n" + action_messages
                    }]
                })

        messages.append({
                "role":"user",
                "content": [
                    {
                        "type":"image_url",
                        "image_url":{
                            "url":f"data:image/png;base64,{encode_image(obs['screenshot'])}",
                            "detail": "high"
                        },
                    },
                    {
                        "type": "text",
                        "text": user_prompt
                    },
                ],
            })

        N = self.N_SEQ

        logger.info(f"Executing planning")
        planner_response = []
        for bn in split_to_batches(N, batch_size=8):
            planner_response_ = self.call_llm({
                    "model": self.planner_model,
                    "messages": messages,
                    "n": bn,
                    "max_completion_tokens": self.max_tokens,
                }, self.planner_model)
            planner_response.extend(planner_response_)
            
        valid_responses = [response for response in planner_response if self.isvalid(response)]
        N = N - len(valid_responses)
        planner_response = [response for response in planner_response if not self.isvalid(response)]
        if planner_response:
            planner_response = planner_response[0]
        retry_count = 0
        max_retries = 5
        while N > 0: 
            logger.info(f"Executing planning {retry_count}")
            if retry_count >= max_retries:
                break
            
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": """You didn't generate a valid "Observation:\n(.*?)\n" section, a valid "Thought:\n(.*?)\n" section,  or valid actions. Please try again."""} #"You didn't generate valid actions. Please try again."} 
                ]
            })
                
            planner_response = []
            for bn in split_to_batches(N, batch_size=8):
                planner_response_ = self.call_llm({
                        "model": self.planner_model,
                        "messages": messages,
                        "n": bn,
                        "max_completion_tokens": self.max_tokens * 4,
                    }, self.planner_model)
                planner_response.extend(planner_response_)

            valid_responses_ = [response for response in planner_response if self.isvalid(response)]
            N = N - len(valid_responses_)
            planner_response = [response for response in planner_response if not self.isvalid(response)]
            if planner_response:
                planner_response = planner_response[0]
            valid_responses.extend(valid_responses_)
            retry_count += 1
            
        # assert len(valid_responses) > int(self.N_SEQ) * 0.8, f"Not enough valid responses generated {len(valid_responses)}"

        logger.info(f"Executing selection")
        if self.N_SEQ > 1:
            history_cache = [f"Observation:\n{o}\nThought:\n{t}\nAction:\n{a}" for a,t,o in zip(self.actions, self.thoughts, self.observation_captions)]
            planner_response = self.select(instruction, Image.open(BytesIO(obs['screenshot'])), valid_responses, history_cache)
        else:
            planner_response = valid_responses[0]
        codes = self.parse_code_from_planner_response(planner_response)
            
        thought = self.parse_thought_from_planner_response(planner_response)
        observation_caption = self.parse_observation_caption_from_planner_response(planner_response)
        
        def request_vllm(image, prompt):
            if isinstance(image, bytes):
                image = np.array(Image.open(BytesIO(image)).convert('RGB'))
            H, W, C = image.shape
            H, W = smart_resize(
                H,
                W,
                factor=28,
                min_pixels=1000,
                max_pixels=1000000000000,
                )
            assert C == 3
            if isinstance(image, np.ndarray):
                image_base64 = encode_numpy_image_to_base64(image)
            elif isinstance(image, bytes):
                image_base64 = encode_image_bytes(image)
            else:
                raise ValueError(f"Invalid image type: {type(image)}")
            messages=[
                {"role": "system", "content": GTA1_GROUNDING_SYSTEM_PROMPT.format(height=H, width=W)},    
                {
                    "role":
                    "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}"
                            },
                        },
                    ],
                }]
            vllm_client = OpenAI(
                base_url=GTA1_SERVICE_URL, 
                api_key=GTA1_API_KEY, 
            )
            response = vllm_client.chat.completions.create(
                    model=GTA1_MODEL_NMAE, 
                    messages=messages,
                    max_tokens=100, 
                    temperature=0,
                    n=1
                )
            result = response.choices[0].message.content
            matches = re.findall(r"\((-?\d*\.?\d+),\s*(-?\d*\.?\d+)\)", result)
            x,y =  [tuple(map(int, match)) for match in matches][0]
            x = x/W
            y = y/H
            return x,y
        logger.info(f"Executing grounding")
        agent.assign_coordinates(planner_response, obs, request_vllm)
        
        plan_code = extract_first_agent_function("\n".join(codes))
        pyautogui_actions = [eval(plan_code)]

        plan_code = [plan_code]
        self.actions.append([plan_code])
        self.observations.append(obs)
        self.thoughts.append(thought)
        self.observation_captions.append(observation_caption)
        self.current_step += 1
     
        if self.current_step >= self.max_steps:
            pyautogui_actions = ["FAIL"]

        return planner_response, pyautogui_actions 
    
    def select(self, instruction, screenshot, response, history_cache):
        height, width = screenshot.height, screenshot.width
        height, width = smart_resize(
            height,
            width,
            factor=28,
            min_pixels=1000,
            max_pixels=1000000000000,
            )
        image = screenshot.resize((height, width))

        system_promt = GTA1_JUDGE_SYSTEM_PROMPT.format(N_PLANNING=len(response), N_INDEX=len(response)-1,width=width,height=height, CLIENT_PASSWORD=self.client_password)
        lines = [
            f"The goal of the task is:\n{instruction}",
        ]
        if len(history_cache) == 0:
            history_cache = ["No history available. The action just started"]

        lines = [
            f"The goal of the task is:\n{instruction}",
            "Here are the past history:"
        ]
        lines += [
            f"### Past step {idx}:\n{step}"
            for idx, step in enumerate(history_cache)
        ]

        lines += ["Here are the different plans to compare:"]
        lines += [
            f"### Index {idx}:\n{plan}"
            for idx, plan in enumerate(response)
        ]
        user_message = "\n".join(lines)
        

        messages = [
            {
                "role": "system",
                "content": [{"type": "text", "text": system_promt}]
            },
            {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{pil_to_base64(image)}"}}, {"type": "text", "text": user_message}]
            }
        ]
        url = "https://api.openai.com/v1/chat/completions"

        headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type":"application/json"}
        payload = {
            "model": "o3",
            "messages": messages,
            "max_completion_tokens": 4096 * 4,
            }
        
        wait = 1
        for _ in range(MAX_RETRY_TIMES):
            try:
                prediction = requests.post(url, headers=headers, json=payload, proxies=proxies, timeout=180)
                if prediction.status_code != 200:
                    continue
                prediction = prediction.json()['choices'][0]['message']['content']
                prediction = extract_answer_from_response(prediction)
                return response[prediction['index']]
            except:
                time.sleep(wait)
                wait *=2
                wait = min(wait,32)
                continue
        return response[0]
    
    def isvalid(self,planner_response):
        try:
            agent.dummy_agent.assign_coordinates(planner_response, {"screenshot": None})
        except:
            return False
        codes = self.parse_code_from_planner_response(planner_response)
        try:
            test_code = extract_first_agent_function("\n".join(codes))
            test_code = "agent.dummy_agent." + test_code[6:]
            eval(test_code)
        except Exception as e:
            #print("Invalid code:", [test_code], str(e), "!!!")
            return False
        thought = self.parse_thought_from_planner_response(planner_response)
        observation_caption = self.parse_observation_caption_from_planner_response(planner_response)
        return bool(codes and thought and observation_caption)
    
    def parse_code_from_planner_response(self, input_string: str) -> List[str]:

        input_string = "\n".join([line.strip() for line in input_string.split(';') if line.strip()])
        
        pattern = r"```(?:\w+\s+)?(.*?)```"
        matches = re.findall(pattern, input_string, re.DOTALL)
        codes = []

        for match in matches:
            match = match.strip()
            codes.append(match)
        return codes
    
    def unsetonestep(self):
        self.actions = self.actions[:-1]
        self.observations = self.actions[:-1]
        self.thoughts.append = self.actions[:-1]
        self.observation_captions = self.actions[:-1]
        self.current_step -= 1
        
    def parse_observation_caption_from_planner_response(self, input_string: str) -> str:
        pattern = r"Observation:\n(.*?)\n"
        matches = re.findall(pattern, input_string, re.DOTALL)
        if matches:
            return matches[0].strip()
        return ""

    def parse_thought_from_planner_response(self, input_string: str) -> str:
        pattern = r"Thought:\n(.*?)\n"
        matches = re.findall(pattern, input_string, re.DOTALL)
        if matches:
            return matches[0].strip()
        return ""
        
    @backoff.on_exception(
        backoff.constant,
        # here you should add more model exceptions as you want,
        # but you are forbidden to add "Exception", that is, a common type of exception
        # because we want to catch this kind of Exception in the outside to ensure
        # each example won't exceed the time limit
        (
            # General exceptions
            SSLError,
            # OpenAI exceptions
            openai.RateLimitError,
            openai.BadRequestError,
            openai.InternalServerError,
            # Google exceptions
            InvalidArgument,
            ResourceExhausted,
            InternalServerError,
            BadRequest,
            # Groq exceptions
            # todo: check
        ),
        interval=30,
        max_tries=10,
    )
    def call_llm(self, payload, model):
        if model.startswith("gpt") or "o3" in model:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"
            }
            response = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers=headers,
                proxies=proxies,
                json=payload,
            )
            #print(response.status_code,"!!!")
            #print(response.json(),"!!!")
            if response.status_code != 200:
                time.sleep(5)
                return ""
            else:
                response = response.json()
                return [response["choices"][i]["message"]["content"] for i in range(len(response["choices"]))]
        else:
           raise SystemExit

    def reset(self, _logger=None):
        global logger
        logger = _logger if _logger is not None else logging.getLogger("desktopenv.agent")

        self.thoughts = []
        self.action_descriptions = []
        self.actions = []
        self.observations = []
        self.observation_captions = []
        self.current_step = 1

        
        
def extract_first_agent_function(code_string):
    '''
    functions borrow from https://github.com/simular-ai/Agent-S/blob/a0c5c9bf0c526119b1f023c8948563c780729428/gui_agents/s2/utils/common_utils.py#L189
    '''
    # Regular expression pattern to match 'agent' functions with any arguments, including nested parentheses
    pattern = r'agent\.[a-zA-Z_]+\((?:[^()\'"]|\'[^\']*\'|"[^"]*")*\)'

    # Find all matches in the string
    matches = re.findall(pattern, code_string)

    # Return the first match if found, otherwise return None
    return matches[0] if matches else None
        
def split_to_batches(n, batch_size=8):
    batches = [batch_size] * (n // batch_size)
    remainder = n % batch_size
    if remainder:
        batches.append(remainder)
    return batches

def extract_answer_from_response(response):
    if not response or not isinstance(response, str):
        raise ValueError("Response must be a non-empty string")
    json_pattern = r'```json\s*(.*?)\s*```'
    json_match = re.search(json_pattern, response, re.DOTALL)
    
    if json_match:
        json_str = json_match.group(1)
        try:
            answer = json.loads(json_str)
            if "explaining" in answer and "index" in answer:
                answer["index"] = int(answer["index"])
                return answer
            else:
                raise ValueError("JSON missing required fields 'explaining' or 'index'")
                
        except json.JSONDecodeError:
            pass
    
    direct_json_pattern = r'\{[\s\S]*?"explaining"[\s\S]*?"index"[\s\S]*?\}'
    direct_match = re.search(direct_json_pattern, response)
    
    if direct_match:
        try:
            json_str = direct_match.group(0)
            json_str = json_str.replace(''', "'").replace(''', "'").replace('"', '"').replace('"', '"')
            answer = json.loads(json_str)
            answer["index"] = int(answer["index"])
            return answer
        except json.JSONDecodeError:
            pass
    index_pattern = r'"index"\s*:\s*(\d+)'
    index_match = re.search(index_pattern, response)
    
    explaining_pattern = r'"explaining"\s*:\s*"(.*?)"(?=,|\s*})'
    explaining_match = re.search(explaining_pattern, response, re.DOTALL)
    
    if not explaining_match:
        explaining_pattern = r'"explaining"\s*:\s*(.*?)(?=,\s*"index"|\s*})'
        explaining_match = re.search(explaining_pattern, response, re.DOTALL)
    
    if index_match and explaining_match:
        return {
            "index": int(index_match.group(1)),
            "explaining": explaining_match.group(1).strip('" \t\n')
        }
    if index_match:
        return {
            "index": int(index_match.group(1)),
            "explaining": "Explanation not found in response"
        }
    raise ValueError("Could not extract valid answer from response")


def pil_to_base64(image):
    '''
    function borrow from https://github.com/xlang-ai/OSWorld/blob/7d0ad02706a7fe742fa1ad6a483782835e3d51e6/mm_agents/uitars_agent.py#L486
    '''
    buffer = BytesIO()
    image.save(buffer, format="PNG") 
    return base64.b64encode(buffer.getvalue()).decode("utf-8")

def encode_numpy_image_to_base64(image: np.ndarray) -> str:
    """Converts a numpy array image to base64 string.
    
    Args:
        image: Numpy array representing an image (height, width, channels)
        
    Returns:
        Base64 encoded string of the image
    """
    # Convert numpy array to bytes
    success, buffer = cv2.imencode('.png', image)
    if not success:
        raise ValueError("Failed to encode image to png format")
    
    # Convert bytes to base64 string
    image_bytes = buffer.tobytes()
    base64_string = base64.b64encode(image_bytes).decode('utf-8')
    
    return base64_string

def encode_image_bytes(image_content):
    return base64.b64encode(image_content).decode('utf-8')