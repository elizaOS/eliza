"""
OpenCUA Agent Implementation

This module implements an OpenCUA agent for desktop automation tasks, building upon
existing frameworks and integrating multiple coordinate mapping systems.

Framework and Implementation Sources:
- Main framework structure follows: https://github.com/xlang-ai/OSWorld/blob/main/mm_agents/agent.py
- Agent implementation adapted from: https://github.com/xlang-ai/OSWorld/blob/main/mm_agents/aguvis_agent.py
- Qwen2.5-VL coordinate mapping from: https://github.com/QwenLM/Qwen2.5-VL/blob/main/qwen-vl-utils/src/qwen_vl_utils/vision_process.py
"""

import re
import os
import ast
import time
import math
import httpx
import base64
import backoff
import traceback
from loguru import logger
from typing import Dict, List, Tuple, Optional
from mm_agents.opencua.utils import (
    encode_image,
    smart_resize,
)
from mm_agents.opencua.prompts import (
    INSTRUTION_TEMPLATE,
    STEP_TEMPLATE,
    ACTION_HISTORY_TEMPLATE,
    THOUGHT_HISTORY_TEMPLATE,
    OBSERVATION_HISTORY_TEMPLATE,
    # OpenCUA-7B, 32B system prompts
    SYSTEM_PROMPT_V1_L1,
    SYSTEM_PROMPT_V1_L2,
    SYSTEM_PROMPT_V1_L3,
    # OpenCUA-72B system prompts
    build_sys_prompt,
)

def parse_response_to_cot_and_action(input_string, screen_size, coordinate_type) -> Tuple[str, List[str], dict]:
    """Parse response including Observation, Thought, Action and code block"""
    sections = {}
    try:

        obs_match = re.search(r'^##\s*Observation\s*:?[\n\r]+(.*?)(?=^##\s*Thought:|^##\s*Action:|^##|\Z)', input_string, re.DOTALL | re.MULTILINE)
        if obs_match:
            sections['observation'] = obs_match.group(1).strip()

        thought_match = re.search(r'^##\s*Thought\s*:?[\n\r]+(.*?)(?=^##\s*Action:|^##|\Z)', input_string, re.DOTALL | re.MULTILINE)
        if thought_match:
            sections['thought'] = thought_match.group(1).strip()

        action_match = re.search(r'^##\s*Action\s*:?[\n\r]+(.*?)(?=^##|\Z)', input_string, re.DOTALL | re.MULTILINE)
        if action_match:
            action = action_match.group(1).strip()
            sections['action'] = action.strip()
        
        code_blocks = re.findall(r'```(?:code|python)?\s*(.*?)\s*```', input_string, re.DOTALL | re.IGNORECASE)
        if not code_blocks:
            logger.error("No code blocks found in the input string")
            return f"<Error>: no code blocks found in the input string: {input_string}", ["FAIL"], sections
        code_block = code_blocks[-1].strip()
        sections['original_code'] = code_block

        if "computer.wait" in code_block.lower():
            sections["code"] = "WAIT"
            return sections['action'], ["WAIT"], sections
            
        elif "computer.terminate" in code_block.lower():
            lower_block = code_block.lower()
            if ("failure" in lower_block) or ("fail" in lower_block):
                sections['code'] = "FAIL"
                return code_block, ["FAIL"], sections
            elif "success" in lower_block:
                sections['code'] = "DONE"
                return code_block, ["DONE"], sections
            else:
                logger.error("Terminate action found but no specific status provided in code block")
                return f"<Error>: terminate action found but no specific status provided in code block: {input_string}", ["FAIL"], sections

        # corrected_code = correct_pyautogui_arguments(code_block)
        corrected_code = code_block
        sections['code'] = corrected_code
        sections['code'] = project_coordinate_to_absolute_scale(corrected_code, screen_width=screen_size[0], screen_height=screen_size[1], coordinate_type=coordinate_type)

        if ('code' not in sections or sections['code'] is None or sections['code'] == "") or ('action' not in sections or sections['action'] is None or sections['action'] == ""):
            logger.error("Missing required action or code section")
            return f"<Error>: no code parsed: {input_string}", ["FAIL"], sections

        return sections['action'], [sections['code']], sections
        
    except Exception as e:
        error_message = f"<Error>: parsing response: {str(e)}\nTraceback:\n{traceback.format_exc()}\nInput string: {input_string}"
        logger.error(error_message)
        return error_message, ['FAIL'], sections

def project_coordinate_to_absolute_scale(pyautogui_code_relative_coordinates, screen_width, screen_height, coordinate_type="relative"):
    """
    Convert the relative coordinates in the pyautogui code to absolute coordinates based on the logical screen size.
    """
    def _coordinate_projection(x, y, screen_width, screen_height, coordinate_type):
        if coordinate_type == "relative":
            return int(round(x * screen_width)), int(round(y * screen_height))
        elif coordinate_type == "qwen25":
            height, width = smart_resize(
                height=screen_height, 
                width=screen_width, 
                factor=28, 
                min_pixels=3136, 
                max_pixels=12845056
            )
            if 0 <= x <= 1 and 0 <= y <= 1:
                # If already normalized, treat like "relative"
                return int(round(x * width)), int(round(y * height))
            return int(x / width * screen_width), int(y / height * screen_height)
        else:
            raise ValueError(f"Invalid coordinate type: {coordinate_type}. Expected one of ['relative', 'relative1000', 'absolute', 'qwen25'].")

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
            return pyautogui_code_relative_coordinates

        function_parameters = {
            'click': ['x', 'y', 'clicks', 'interval', 'button', 'duration', 'pause'],
            'rightClick':  ['x', 'y', 'duration', 'tween', 'pause'],
            'middleClick': ['x', 'y', 'duration', 'tween', 'pause'],
            'doubleClick': ['x', 'y', 'interval', 'button', 'duration', 'pause'],
            'tripleClick': ['x', 'y', 'interval', 'button', 'duration', 'pause'],
            'moveTo': ['x', 'y', 'duration', 'tween', 'pause'],
            'dragTo': ['x', 'y', 'duration', 'button', 'mouseDownUp', 'pause'],
        }

        func_base_name = func_name.split('.')[-1]

        param_names = function_parameters.get(func_base_name, [])

        args = {}
        for idx, arg in enumerate(parsed_args):
            if idx < len(param_names):
                param_name = param_names[idx]
                arg_value = ast.literal_eval(arg)
                args[param_name] = arg_value

        try:
            for kw in parsed_keywords:
                param_name = kw.arg
                arg_value = ast.literal_eval(kw.value)
                args[param_name] = arg_value
        except Exception as e:
            logger.error(f"Error parsing keyword arguments: {e}")
            return pyautogui_code_relative_coordinates

        updated = False
        if 'x' in args and 'y' in args:
            try:
                x_rel = float(args['x'])
                y_rel = float(args['y'])
                x_abs, y_abs = _coordinate_projection(x_rel, y_rel, screen_width, screen_height, coordinate_type)
                logger.warning(f"Projecting coordinates: ({x_rel}, {y_rel}) to ({x_abs}, {y_abs}) using {coordinate_type} projection.")
                args['x'] = x_abs
                args['y'] = y_abs
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

def transform_agnet_action_to_code_block(action):
    if any(keyword in action for keyword in ["computer.terminate", "computer.wait", "browser.select_option", "browser.clear"]):
        return f"```code\n{action}\n```"
    else:
        return f"```python\n{action}\n```"

class OpenCUAAgent:
    """
    OpenCUA Agent for desktop automation tasks.
    
    This class implements a OpenCUA Model based agent that can observe 
    desktop environments through screenshots and execute mouse/keyboard actions 
    via PyAutoGUI to complete automation tasks.
    
    Attributes:
        model (str): Name of the language model being used
        history_type (str): Type of history recording mechanism
        actions (list): History of executed actions
        observations (list): History of environment observations
        cots (list): Chain of thought reasoning records
    """
    def __init__(
            self,
            model: str, # OpenCUA model name
            history_type: str, # History step type: action_history, thought_history, observation_history
            max_steps: int, # The max number of steps to finish the task
            max_image_history_length: int = 3, # The max number of images in the history
            platform: str = "ubuntu", # The platform of the computer
            max_tokens: int = 1500, # The max number of tokens in the response
            top_p: float = 0.9, # The top p value in the response
            temperature: float = 0, # The temperature value in the response
            action_space: str = "pyautogui", # The action space: pyautogui
            observation_type: str = "screenshot", # The observation type: screenshot
            cot_level: str = "l2", # The CoT level: l1, l2, l3
            screen_size: Tuple[int, int] = (1920, 1080), # The screen size
            coordinate_type: str = "relative", # The coordinate type: relative, absolute, qwen25
            use_old_sys_prompt: bool = False, # Whether to use the old system prompt
            password="osworld-public-evaluation", # The password for the ubuntu platform
            **kwargs
    ):
        assert coordinate_type in ["relative", "absolute", "qwen25"]
        assert action_space in ["pyautogui"], "Invalid action space"
        assert observation_type in ["screenshot"], "Invalid observation type"
        assert history_type in ["action_history", "thought_history", "observation_history"]
        assert model is not None, "Model cannot be None"

        self.model = model
        self.platform = platform
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        self.history_type = history_type
        self.coordinate_type = coordinate_type
        self.cot_level = cot_level
        self.screen_size = screen_size
        self.max_image_history_length = max_image_history_length
        self.max_steps = max_steps
        self.password = password

        if history_type == "action_history":
            self.HISTORY_TEMPLATE = ACTION_HISTORY_TEMPLATE
        elif history_type == "thought_history":
            self.HISTORY_TEMPLATE = THOUGHT_HISTORY_TEMPLATE
        elif history_type == "observation_history":
            self.HISTORY_TEMPLATE = OBSERVATION_HISTORY_TEMPLATE
        else:
            raise ValueError(f"Invalid history type: {history_type}")
        
        if use_old_sys_prompt:
            if cot_level == "l1":
                self.system_prompt = SYSTEM_PROMPT_V1_L1
            elif cot_level == "l2":
                self.system_prompt = SYSTEM_PROMPT_V1_L2
            elif cot_level == "l3":
                self.system_prompt = SYSTEM_PROMPT_V1_L3
            else:
                raise ValueError("Invalid cot_level. Choose from 'l1', 'l2', or 'l3'.")
        else:
            self.system_prompt = build_sys_prompt(
                level=self.cot_level, 
                password=self.password,
                use_random=False
                )

        self.actions = []
        self.observations = []
        self.cots = []

    def reset(self, _logger=None):
        global logger
        logger = _logger if _logger is not None else logging.getLogger("desktopenv.agent")
        
        self.observations = []
        self.cots = []
        self.actions = []
    
    def _scale_scroll_for_windows(self, code: str, factor: int = 50) -> str:
        """ pyautogui.scroll has a different scale on Ubuntu and Windows, multiple 'factor' when scrolling on Windows system"""
        if self.platform.lower() != "windows":
            return code

        pattern_pos = re.compile(r'(pyautogui\.scroll\()\s*([-+]?\d+)\s*\)')
        code = pattern_pos.sub(lambda m: f"{m.group(1)}{int(m.group(2))*factor})", code)
        return code
    
    def predict(self, instruction: str, obs: Dict, **kwargs) -> Tuple[str, List[str], Dict]:
        """
        Predict the next action(s) based on the current observation.
        """
        if "step_idx" in kwargs:
            logger.info(f"========= {self.model} Step {kwargs['step_idx']} =======")
        else:
            logger.info(f"========================== {self.model} ===================================")
        logger.info(f"Instruction: \n{instruction}")

        messages = []
        messages.append({
                "role": "system",
                "content": self.system_prompt
            })
        instruction_prompt = INSTRUTION_TEMPLATE.format(instruction=instruction)

        history_step_texts = []
        for i in range(len(self.actions)):
            if i > len(self.actions) - self.max_image_history_length:
                messages.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{encode_image(self.observations[i]['screenshot'])}"}
                        }
                    ]
                })

                history_content = STEP_TEMPLATE.format(step_num=i+1) + self.HISTORY_TEMPLATE.format(
                    observation=self.cots[i].get('observation'),
                    thought=self.cots[i].get('thought'),
                    action=self.cots[i].get('action')
                )

                messages.append({
                    "role": "assistant",
                    "content": history_content
                })
            else:
                history_content = STEP_TEMPLATE.format(step_num=i+1) + self.HISTORY_TEMPLATE.format(
                    observation=self.cots[i].get('observation'),
                    thought=self.cots[i].get('thought'),
                    action=self.cots[i].get('action')
                )
                history_step_texts.append(history_content)
                if i == len(self.actions) - self.max_image_history_length:
                    messages.append({
                        "role":"assistant",
                        "content": "\n".join(history_step_texts)
                    })

        messages.append({
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{encode_image(obs['screenshot'])}"}
                },
                {
                    "type": "text",
                    "text": instruction_prompt
                }
            ]
        })

        max_retry = 5
        retry_count = 0
        low_level_instruction = None
        pyautogui_actions = None
        other_cot = {}

        while retry_count < max_retry:
            try:
                response = self.call_llm({
                    "model": self.model,
                    "messages": messages,
                    "max_tokens": self.max_tokens,
                    "top_p": self.top_p,
                    "temperature": self.temperature if retry_count==0 else max(0.2, self.temperature)
                }, self.model)

                logger.info(f"Model Output: \n{response}")
                if not response:
                    logger.error("No response found in the response.")
                    raise ValueError(f"No response found in the response:\n{response}.")

                low_level_instruction, pyautogui_actions, other_cot = parse_response_to_cot_and_action(response, self.screen_size, self.coordinate_type)
                if "<Error>" in low_level_instruction or not pyautogui_actions:
                    logger.error(f"Error parsing response: {low_level_instruction}")
                    raise ValueError(f"Error parsing response: {low_level_instruction}")
                break
                
            except Exception as e:
                logger.error(f"Error during message preparation: {e}")
                retry_count += 1
                if retry_count == max_retry:
                    logger.error("Maximum retries reached. Exiting.")
                    return str(e), ['FAIL'], other_cot

        pyautogui_actions = [
            self._scale_scroll_for_windows(code) for code in pyautogui_actions
        ]
        logger.info(f"Action: \n{low_level_instruction}")
        logger.info(f"Code: \n{pyautogui_actions}")

        self.observations.append(obs)
        self.actions.append(low_level_instruction)
        self.cots.append(other_cot)

        current_step = len(self.actions)
        if current_step >= self.max_steps and 'computer.terminate' not in pyautogui_actions[0].lower():
            logger.warning(f"Reached maximum steps {self.max_steps}. Forcing termination.")
            low_level_instruction = 'Fail the task because reaching the maximum step limit.'
            pyautogui_actions = ['FAIL']
            other_cot['code'] = 'FAIL'

        return response, pyautogui_actions, other_cot
            
    
    def call_llm(self, payload, model):
        """Call the LLM API"""
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ['OPENCUA_API_KEY']}"
        }

        for _ in range(20):
            response = httpx.post(
                f"https://{self.model}.app.msh.team/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=500,
                verify=False
            )

            if response.status_code != 200:
                logger.error("Failed to call LLM: " + response.text)
                logger.error("Retrying...")
                time.sleep(5)
            else:
                response = response.json()
                finish_reason = response["choices"][0].get("finish_reason")
                if finish_reason is not None and finish_reason == "stop": # for most of the time, length will not exceed max_tokens
                    return response['choices'][0]['message']['content']
                else:
                    logger.error("LLM did not finish properly, retrying...")
                    time.sleep(5)
