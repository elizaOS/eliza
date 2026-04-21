import base64
import json
import logging
import os
import re
import tempfile
import time
from http import HTTPStatus
from io import BytesIO
from typing import Dict, List, Tuple

import backoff
import openai
import requests
from PIL import Image
from google.api_core.exceptions import InvalidArgument, ResourceExhausted, InternalServerError, BadRequest
from requests.exceptions import SSLError
from mm_agents.prompts import (
    AGUVIS_PLANNER_SYS_PROMPT,
    AGUVIS_SYS_PROMPT,
    AGUVIS_PLANNING_PROMPT,
    AGUVIS_INNER_MONOLOGUE_APPEND_PROMPT,
    AGUVIS_GROUNDING_PROMPT,
    AGUVIS_GROUNDING_APPEND_PROMPT
)

logger = None


# Function to encode the image
def encode_image(image_content):
    return base64.b64encode(image_content).decode('utf-8')


def encoded_img_to_pil_img(data_str):
    base64_str = data_str.replace("data:image/png;base64,", "")
    image_data = base64.b64decode(base64_str)
    image = Image.open(BytesIO(image_data))

    return image


def save_to_tmp_img_file(data_str):
    base64_str = data_str.replace("data:image/png;base64,", "")
    image_data = base64.b64decode(base64_str)
    image = Image.open(BytesIO(image_data))

    tmp_img_path = os.path.join(tempfile.mkdtemp(), "tmp_img.png")
    image.save(tmp_img_path)

    return tmp_img_path


# FIXME: hardcoded screen size and planner system message
SCREEN_LOGIC_SIZE = (1280, 720)


def parse_code_from_planner_response(input_string: str) -> List[str]:
    """Parse the planner's response containing executable pyautogui code"""

    input_string = "\n".join([line.strip() for line in input_string.split(';') if line.strip()])
    if input_string.strip() in ['WAIT', 'DONE', 'FAIL']:
        return [input_string.strip()]

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
        commands = ['WAIT', 'DONE', 'FAIL']

        if match in commands:
            codes.append(match.strip())
        elif match.split('\n')[-1] in commands:
            if len(match.split('\n')) > 1:
                codes.append("\n".join(match.split('\n')[:-1]))
            codes.append(match.split('\n')[-1])
        else:
            codes.append(match)

    return codes


def parse_aguvis_response(input_string, screen_logic_size=SCREEN_LOGIC_SIZE) -> Tuple[str, List[str]]:
    if input_string.lower().startswith("wait"):
        return "WAIT", "WAIT"
    elif input_string.lower().startswith("done"):
        return "DONE", "DONE"
    elif input_string.lower().startswith("fail"):
        return "FAIL", "FAIL"

    try:
        lines = input_string.strip().split("\n")
        lines = [line for line in lines if line.strip() != ""]
        low_level_instruction = lines[0]

        pyautogui_index = -1

        for i, line in enumerate(lines):
            if line.strip() == "assistantos" or line.strip().startswith("pyautogui"):
                pyautogui_index = i
                break

        if pyautogui_index == -1:
            print(f"Error: Could not parse response {input_string}")
            return None, None

        pyautogui_code_relative_coordinates = "\n".join(lines[pyautogui_index:])
        pyautogui_code_relative_coordinates = pyautogui_code_relative_coordinates.replace("assistantos", "").strip()
        corrected_code = correct_pyautogui_arguments(pyautogui_code_relative_coordinates)

        parsed_action = _pyautogui_code_to_absolute_coordinates(corrected_code, screen_logic_size)
        return low_level_instruction, parsed_action
    except Exception as e:
        print(f"Error: Could not parse response {input_string}")
        return None, None

def correct_pyautogui_arguments(code: str) -> str:
    function_corrections = {
        'write': {
            'incorrect_args': ['text'],
            'correct_args': [],
            'keyword_arg': 'message'
        },
        'press': {
            'incorrect_args': ['key', 'button'],
            'correct_args': [],
            'keyword_arg': None
        },
        'hotkey': {
            'incorrect_args': ['key1', 'key2', 'keys'],
            'correct_args': [],
            'keyword_arg': None
        },
    }

    lines = code.strip().split('\n')
    corrected_lines = []

    for line in lines:
        line = line.strip()
        match = re.match(r'(pyautogui\.(\w+))\((.*)\)', line)
        if match:
            full_func_call = match.group(1)
            func_name = match.group(2)
            args_str = match.group(3)

            if func_name in function_corrections:
                func_info = function_corrections[func_name]
                args = split_args(args_str)
                corrected_args = []

                for arg in args:
                    arg = arg.strip()
                    kwarg_match = re.match(r'(\w+)\s*=\s*(.*)', arg)
                    if kwarg_match:
                        arg_name = kwarg_match.group(1)
                        arg_value = kwarg_match.group(2)

                        if arg_name in func_info['incorrect_args']:
                            if func_info['keyword_arg']:
                                corrected_args.append(f"{func_info['keyword_arg']}={arg_value}")
                            else:
                                corrected_args.append(arg_value)
                        else:
                            corrected_args.append(f'{arg_name}={arg_value}')
                    else:
                        corrected_args.append(arg)

                corrected_args_str = ', '.join(corrected_args)
                corrected_line = f'{full_func_call}({corrected_args_str})'
                corrected_lines.append(corrected_line)
            else:
                corrected_lines.append(line)
        else:
            corrected_lines.append(line)

    corrected_code = '\n'.join(corrected_lines)
    return corrected_code

def split_args(args_str: str) -> List[str]:
    args = []
    current_arg = ''
    within_string = False
    string_char = ''
    prev_char = ''
    for char in args_str:
        if char in ['"', "'"]:
            if not within_string:
                within_string = True
                string_char = char
            elif within_string and prev_char != '\\' and char == string_char:
                within_string = False
        if char == ',' and not within_string:
            args.append(current_arg)
            current_arg = ''
        else:
            current_arg += char
        prev_char = char
    if current_arg:
        args.append(current_arg)
    return args

def extract_coordinates(text, logical_screen_size=SCREEN_LOGIC_SIZE) -> Tuple[int, int] | None:
    # Pattern to match (x=0.1, y=0.2) or (0.1, 0.2) format
    text = text.strip()
    logger.info(f"Extracting coordinates from: {text}")
    pattern = r'\((?:x=)?([-+]?\d*\.\d+|\d+)(?:,\s*(?:y=)?([-+]?\d*\.\d+|\d+))?\)'

    match = re.search(pattern, text)
    if match:
        x = int(float(match.group(1)) * logical_screen_size[0])
        y = int(float(match.group(2)) * logical_screen_size[1]) if match.group(2) else None

        if y is not None:
            return (x, y)

    logger.info(f"Error: No coordinates found in: {text}")
    return None


def _pyautogui_code_to_absolute_coordinates(pyautogui_code_relative_coordinates, logical_screen_size=SCREEN_LOGIC_SIZE):
    """
    Convert the relative coordinates in the pyautogui code to absolute coordinates based on the logical screen size.
    """
    import re
    import ast

    width, height = logical_screen_size

    pattern = r'(pyautogui\.\w+\([^\)]*\))'

    matches = re.findall(pattern, pyautogui_code_relative_coordinates)

    new_code = pyautogui_code_relative_coordinates

    for full_call in matches:
        func_name_pattern = r'(pyautogui\.\w+)\((.*)\)'
        func_match = re.match(func_name_pattern, full_call, re.DOTALL)
        if not func_match:
            continue

        func_name = func_match.group(1)
        args_str = func_match.group(2)

        try:
            parsed = ast.parse(f"func({args_str})").body[0].value
            parsed_args = parsed.args
            parsed_keywords = parsed.keywords
        except SyntaxError:
            continue

        function_parameters = {
            'click': ['x', 'y', 'clicks', 'interval', 'button', 'duration', 'pause'],
            'moveTo': ['x', 'y', 'duration', 'tween', 'pause'],
            'moveRel': ['xOffset', 'yOffset', 'duration', 'tween', 'pause'],
            'dragTo': ['x', 'y', 'duration', 'button', 'mouseDownUp', 'pause'],
            'dragRel': ['xOffset', 'yOffset', 'duration', 'button', 'mouseDownUp', 'pause'],
            'doubleClick': ['x', 'y', 'interval', 'button', 'duration', 'pause'],
        }

        func_base_name = func_name.split('.')[-1]

        param_names = function_parameters.get(func_base_name, [])

        args = {}
        for idx, arg in enumerate(parsed_args):
            if idx < len(param_names):
                param_name = param_names[idx]
                arg_value = ast.literal_eval(arg)
                args[param_name] = arg_value

        for kw in parsed_keywords:
            param_name = kw.arg
            arg_value = ast.literal_eval(kw.value)
            args[param_name] = arg_value

        updated = False
        if 'x' in args:
            try:
                x_rel = float(args['x'])
                x_abs = int(round(x_rel * width))
                args['x'] = x_abs
                updated = True
            except ValueError:
                pass
        if 'y' in args:
            try:
                y_rel = float(args['y'])
                y_abs = int(round(y_rel * height))
                args['y'] = y_abs
                updated = True
            except ValueError:
                pass
        if 'xOffset' in args:
            try:
                x_rel = float(args['xOffset'])
                x_abs = int(round(x_rel * width))
                args['xOffset'] = x_abs
                updated = True
            except ValueError:
                pass
        if 'yOffset' in args:
            try:
                y_rel = float(args['yOffset'])
                y_abs = int(round(y_rel * height))
                args['yOffset'] = y_abs
                updated = True
            except ValueError:
                pass

        if updated:
            reconstructed_args = []
            for idx, param_name in enumerate(param_names):
                if param_name in args:
                    arg_value = args[param_name]
                    if isinstance(arg_value, str):
                        arg_repr = f"'{arg_value}'"
                    else:
                        arg_repr = str(arg_value)
                    reconstructed_args.append(arg_repr)
                else:
                    break

            used_params = set(param_names[:len(reconstructed_args)])
            for kw in parsed_keywords:
                if kw.arg not in used_params:
                    arg_value = args[kw.arg]
                    if isinstance(arg_value, str):
                        arg_repr = f"{kw.arg}='{arg_value}'"
                    else:
                        arg_repr = f"{kw.arg}={arg_value}"
                    reconstructed_args.append(arg_repr)

            new_args_str = ', '.join(reconstructed_args)
            new_full_call = f"{func_name}({new_args_str})"
            new_code = new_code.replace(full_call, new_full_call)

    return new_code


class AguvisAgent:
    def __init__(
            self,
            platform="ubuntu",
            planner_model="gpt-4o",
            executor_model="qwen-aguvis-7b",
            max_tokens=1500,
            top_p=0.9,
            temperature=0.5,
            action_space="pyautogui",
            observation_type="screenshot",
            client_password="password"
    ):
        self.platform = platform
        self.planner_model = planner_model
        self.executor_model = executor_model
        assert self.executor_model is not None, "Executor model cannot be None"
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        assert action_space in ["pyautogui"], "Invalid action space"
        assert observation_type in ["screenshot"], "Invalid observation type"
        self.client_password = client_password

        self.thoughts = []
        self.actions = []
        self.observations = []

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Predict the next action(s) based on the current observation.
        """
        previous_actions = "\n".join([f"Step {i+1}: {action}" for i, action in enumerate(self.actions)]) if self.actions else "None"

        if self.planner_model is None:
            aguvis_messages = []
            aguvis_messages.append({
                "role": "system",
                "content": [{"type": "text", "text": AGUVIS_SYS_PROMPT}]
            })
            aguvis_messages.append({
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": AGUVIS_PLANNING_PROMPT.format(
                            instruction=instruction,
                            previous_actions=previous_actions,
                        )
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{encode_image(obs['screenshot'])}"}
                    }
                ],
            })
            aguvis_messages.append({
                "role": "assistant",
                "content": [
                    {"type": "text", "text": AGUVIS_INNER_MONOLOGUE_APPEND_PROMPT}
                ]
            })
            aguvis_response = self.call_llm({
                "model": self.executor_model,
                "messages": aguvis_messages,
                "max_tokens": self.max_tokens,
                "top_p": self.top_p,
                "temperature": self.temperature
            }, self.executor_model)
            logger.info(f"Aguvis Output: {aguvis_response}")
            low_level_instruction, pyautogui_actions = parse_aguvis_response(aguvis_response)

            self.actions.append(low_level_instruction)
            return aguvis_response, [pyautogui_actions]
        else:
            # FIXME [junli]:
            # Using an external planner (GPT-4o) requires relying on more
            # detailed prompt to provide Aguvis with low level instructions.
            # So we temporarily separate the planner prompt and aguvis prompt.

            planner_messages = []
            planner_system_message = AGUVIS_PLANNER_SYS_PROMPT.format(CLIENT_PASSWORD=self.client_password)
            planner_messages.append({
                "role": "system",
                "content": [{"type": "text", "text": planner_system_message}]
            })
            planner_messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"You are asked to complete the following task: {instruction}"
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{encode_image(obs['screenshot'])}",
                                "detail": "high"
                            }
                        }
                    ]
                }
            )
            planner_response = self.call_llm({
                "model": self.planner_model,
                "messages": planner_messages,
                "max_tokens": self.max_tokens,
                "top_p": self.top_p,
                "temperature": self.temperature
            }, self.planner_model)
            logger.info(f"Planner output: {planner_response}")
            code = parse_code_from_planner_response(planner_response)
            pyautogui_actions = []
            for line in code:
                code = self.convert_action_to_grounding_model_instruction(
                    line,
                    obs,
                    instruction,
                )
                pyautogui_actions.append(code)

            return "", pyautogui_actions

    def convert_action_to_grounding_model_instruction(
        self, line: str, obs: Dict, instruction: str
    ) -> str:
        pattern = r'(#.*?)\n(pyautogui\.(moveTo|click|rightClick)\((?:x=)?(\d+)(?:,\s*|\s*,\s*y=)(\d+)(?:,\s*duration=[\d.]+)?\))'
        matches = re.findall(pattern, line, re.DOTALL)
        if not matches:
            return line
        new_instruction = line
        for match in matches:
            comment = match[0].split("#")[1].strip()
            original_action = match[1]
            func_name = match[2].strip()

            if "click()" in original_action.lower():
                continue  # Skip click() without coordinates
            
            aguvis_messages = []
            aguvis_messages.append({
                "role": "system",
                "content": [{"type": "text", "text": AGUVIS_SYS_PROMPT}]
            })
            aguvis_messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{encode_image(obs['screenshot'])}",
                                "detail": "high",
                            },
                        },
                        {
                            "type": "text",
                            "text": '\n' + comment,
                        },
                    ],
                }
            )
            aguvis_messages.append(
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": AGUVIS_GROUNDING_APPEND_PROMPT.format(function_name=func_name)}
                    ],
                }
            )
            grounding_response = self.call_llm({
                "model": self.executor_model,
                "messages": aguvis_messages,
                "max_tokens": self.max_tokens,
                "top_p": self.top_p,
                "temperature": self.temperature
            }, self.executor_model)
            coordinates = extract_coordinates(grounding_response, SCREEN_LOGIC_SIZE)
            # FIXME [junli]: Use ast to reconstruct the action with coordinates
            action_parts = original_action.split('(')
            new_action = f"{action_parts[0]}({coordinates[0]}, {coordinates[1]}"
            if len(action_parts) > 1 and 'duration' in action_parts[1]:
                duration_part = action_parts[1].split(',')[-1]
                new_action += f", {duration_part}"
            elif len(action_parts) > 1 and 'button' in action_parts[1]:
                button_part = action_parts[1].split(',')[-1]
                new_action += f", {button_part}"
            else:
                new_action += ")"
            logger.info(new_action)
            new_instruction = new_instruction.replace(original_action, new_action)

        return new_instruction

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
        max_tries=10
    )
    def call_llm(self, payload, model):
        if model.startswith("gpt"):
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"
                # "Authorization": f"Bearer {os.environ['MIT_SPIDER_TOKEN']}"
            }
            logger.info("Generating content with GPT model: %s", model)
            response = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers=headers,
                json=payload
            )

            if response.status_code != 200:
                logger.error("Failed to call LLM: " + response.text)
                time.sleep(5)
                return ""
            else:
                return response.json()['choices'][0]['message']['content']
        elif "aguvis" in model:
            headers = {
                "Content-Type": "application/json",
            }
            logger.info("Generating content with Aguvis model: %s", model)

            if "7b" in model:
                response = requests.post(
                    "http://101.132.136.195:7908/v1/chat/completions",
                    headers=headers,
                    json=payload
                )
            elif "72b" in model:
                response = requests.post(
                    "http://123.57.10.166:7908/v1/chat/completions",
                    headers=headers,
                    json=payload
                )
            else:
                raise Exception("Unsupported Aguvis model version")

            if response.status_code != 200:
                logger.error("Failed to call LLM: " + response.text)
                time.sleep(5)
                return ""
            else:
                return response.json()['choices'][0]['message']['content']

    def reset(self, _logger=None):
        global logger
        logger = _logger if _logger is not None else logging.getLogger("desktopenv.aguvis_agent")

        self.thoughts = []
        self.action_descriptions = []
        self.actions = []
        self.observations = []
