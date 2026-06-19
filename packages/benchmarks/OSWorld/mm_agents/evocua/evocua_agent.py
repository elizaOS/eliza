import os
import re
import json
import logging
import backoff
import openai
from typing import Dict, List, Tuple, Optional

from io import BytesIO
from PIL import Image

from mm_agents.evocua.utils import (
    process_image,
    encode_image,
    rewrite_pyautogui_text_inputs,
    project_coordinate_to_absolute_scale,
    log_messages
)

from mm_agents.evocua.prompts import (
    S1_SYSTEM_PROMPT,
    S1_INSTRUTION_TEMPLATE,
    S1_STEP_TEMPLATE,
    S1_ACTION_HISTORY_TEMPLATE,
    S2_ACTION_DESCRIPTION,
    S2_DESCRIPTION_PROMPT_TEMPLATE,
    S2_SYSTEM_PROMPT,
    build_s2_tools_def
)

logger = logging.getLogger("desktopenv.evocua")

class EvoCUAAgent:
    """
    EvoCUA - A Native GUI agent model for desktop automation.
    """
    
    def __init__(
        self,
        model: str = "EvoCUA-S2",
        max_tokens: int = 32768,
        top_p: float = 0.9,
        temperature: float = 0.0,
        action_space: str = "pyautogui",
        observation_type: str = "screenshot",
        max_steps: int = 50,
        prompt_style: str = "S2", # "S1" or "S2"
        max_history_turns: int = 4,
        screen_size: Tuple[int, int] = (1920, 1080),
        coordinate_type: str = "relative",
        password: str = "osworld-public-evaluation",
        resize_factor: int = 32,
        **kwargs
    ):
        self.model = model
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        self.max_steps = max_steps
        
        self.prompt_style = prompt_style
        assert self.prompt_style in ["S1", "S2"], f"Invalid prompt_style: {self.prompt_style}"
        
        self.max_history_turns = max_history_turns
        
        self.screen_size = screen_size
        self.coordinate_type = coordinate_type
        self.password = password
        self.resize_factor = resize_factor
        
        # Action space assertion
        assert self.action_space == "pyautogui", f"Invalid action space: {self.action_space}"
        assert self.observation_type == "screenshot", f"Invalid observation type: {self.observation_type}"
       
        # State
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.responses = []
        self.screenshots = [] # Stores encoded string
        self.cots = [] # For S1 style history

    def reset(self, _logger=None, vm_ip=None):
        global logger
        if _logger:
            logger = _logger
        
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.responses = []
        self.screenshots = []
        self.cots = []

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Main prediction loop.
        """
        
        logger.info(f"========================== {self.model} ===================================")
        logger.info(f"Instruction: \n{instruction}")
        
        screenshot_bytes = obs["screenshot"]
 
        try:
            original_img = Image.open(BytesIO(screenshot_bytes))
            original_width, original_height = original_img.size
        except Exception as e:
            logger.warning(f"Failed to read screenshot size, falling back to screen_size: {e}")
            original_width, original_height = self.screen_size
        
        if self.prompt_style == "S1":
            raw_b64 = encode_image(screenshot_bytes)
            self.screenshots.append(raw_b64)
            return self._predict_s1(instruction, obs, raw_b64)
        else:
            processed_b64, p_width, p_height = process_image(screenshot_bytes, factor=self.resize_factor)
            self.screenshots.append(processed_b64)
            return self._predict_s2(
                instruction,
                obs,
                processed_b64,
                p_width,
                p_height,
                original_width,
                original_height,
            )

  
    def _predict_s2(self, instruction, obs, processed_b64, p_width, p_height, original_width, original_height):
        current_step = len(self.actions)
        current_history_n = self.max_history_turns
        
        response = None
        
        if self.coordinate_type == "absolute":
             resolution_info = f"* The screen's resolution is {p_width}x{p_height}."
        else:
             resolution_info = "* The screen's resolution is 1000x1000."
             
        description_prompt = S2_DESCRIPTION_PROMPT_TEMPLATE.format(resolution_info=resolution_info)

        tools_def = build_s2_tools_def(description_prompt)

        system_prompt = S2_SYSTEM_PROMPT.format(tools_xml=json.dumps(tools_def))

        # Retry loop for context length
        while True:
            messages = self._build_s2_messages(
                instruction, 
                processed_b64, 
                current_step, 
                current_history_n, 
                system_prompt
            )
            
            try:
                response = self.call_llm({
                    "model": self.model,
                    "messages": messages,
                    "max_tokens": self.max_tokens,
                    "top_p": self.top_p,
                    "temperature": self.temperature,
                })
                break
            except Exception as e:
                # Handle Context Too Large
                if self._should_giveup_on_context_error(e) and current_history_n > 0:
                    current_history_n -= 1
                    logger.warning(f"Context too large, retrying with history_n={current_history_n}")
                else:
                    logger.error(f"Error in predict: {e}")
                    break
        
        self.responses.append(response)
        
        low_level_instruction, pyautogui_code = self._parse_response_s2(
            response, p_width, p_height, original_width, original_height
        )
        
        # new added
        current_step = len(self.actions) + 1
        first_action = pyautogui_code[0] if pyautogui_code else ""
        if current_step >= self.max_steps and str(first_action).upper() not in ("DONE", "FAIL"):
            logger.warning(f"Reached maximum steps {self.max_steps}. Forcing termination with FAIL.")
            low_level_instruction = "Fail the task because reaching the maximum step limit."
            pyautogui_code = ["FAIL"]

        logger.info(f"Low level instruction: {low_level_instruction}")
        logger.info(f"Pyautogui code: {pyautogui_code}")

        self.actions.append(low_level_instruction)
        return response, pyautogui_code

    def _build_s2_messages(self, instruction, current_img, step, history_n, system_prompt):
        messages = [{"role": "system", "content": [{"type": "text", "text": system_prompt}]}]
        
        previous_actions = []
        history_start_idx = max(0, step - history_n)
        for i in range(history_start_idx):
             if i < len(self.actions):
                 previous_actions.append(f"Step {i+1}: {self.actions[i]}")
        previous_actions_str = "\n".join(previous_actions) if previous_actions else "None"

        # Add History
        history_len = min(history_n, len(self.responses))
        if history_len > 0:
            hist_responses = self.responses[-history_len:]
            hist_imgs = self.screenshots[-history_len-1:-1]
            
            for i in range(history_len):
                if i < len(hist_imgs):
                    screenshot_b64 = hist_imgs[i]
                    if i == 0:
                        # First history item: Inject Instruction + Previous Actions Context
                        img_url = f"data:image/png;base64,{screenshot_b64}"
                        instruction_prompt = f"""
Please generate the next move according to the UI screenshot, instruction and previous actions.

Instruction: {instruction}

Previous actions:
{previous_actions_str}"""
                        messages.append({
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": img_url}},
                                {"type": "text", "text": instruction_prompt}
                            ]
                        })
                    else:
                        img_url = f"data:image/png;base64,{screenshot_b64}"
                        messages.append({
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": img_url}},
                            ]
                        })
                
                messages.append({
                    "role": "assistant",
                    "content": [{"type": "text", "text": hist_responses[i]}]
                })
        
        # Current Turn
        # We re-use previous_actions_str logic for the case where history_len == 0
        
        if history_len == 0:
            # First turn logic: Include Instruction + Previous Actions
            instruction_prompt = f"""
Please generate the next move according to the UI screenshot, instruction and previous actions.

Instruction: {instruction}

Previous actions:
{previous_actions_str}"""
            messages.append({
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{current_img}"}},
                    {"type": "text", "text": instruction_prompt}
                ]
            })
        else:
            # Subsequent turns logic (context already in first history message): Image Only
            messages.append({
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{current_img}"}}
                ]
            })

        return messages


    def _parse_response_s2(
        self,
        response: str,
        processed_width: int = None,
        processed_height: int = None,
        original_width: Optional[int] = None,
        original_height: Optional[int] = None,
    ) -> Tuple[str, List[str]]:
        """
        Parse LLM response and convert it to low level action and pyautogui code.
        """
        # Prefer the real screenshot resolution (passed from predict), fallback to configured screen_size.
        if not (original_width and original_height):
            original_width, original_height = self.screen_size
        low_level_instruction = ""
        pyautogui_code: List[str] = []

        if response is None or not response.strip():
            return low_level_instruction, pyautogui_code

        def adjust_coordinates(x: float, y: float) -> Tuple[int, int]:
            if not (original_width and original_height):
                return int(x), int(y)
            if self.coordinate_type == "absolute":
                # scale from processed pixels to original
                if processed_width and processed_height:
                    x_scale = original_width / processed_width
                    y_scale = original_height / processed_height
                    return int(x * x_scale), int(y * y_scale)
                return int(x), int(y)
            # relative: scale from 0..999 grid
            x_scale = original_width / 999
            y_scale = original_height / 999
            return int(x * x_scale), int(y * y_scale)

        def process_tool_call(json_str: str) -> None:
            try:
                tool_call = json.loads(json_str)
                if tool_call.get("name") == "computer_use":
                    args = tool_call["arguments"]
                    action = args["action"]

                    def _clean_keys(raw_keys):
                        keys = raw_keys if isinstance(raw_keys, list) else [raw_keys]
                        cleaned_keys = []
                        for key in keys:
                            if isinstance(key, str):
                                if key.startswith("keys=["):
                                    key = key[6:]
                                if key.endswith("]"):
                                    key = key[:-1]
                                if key.startswith("['") or key.startswith('["'):
                                    key = key[2:] if len(key) > 2 else key
                                if key.endswith("']") or key.endswith('"]'):
                                    key = key[:-2] if len(key) > 2 else key
                                key = key.strip()
                                cleaned_keys.append(key)
                            else:
                                cleaned_keys.append(key)
                        return cleaned_keys

                    if action == "left_click" or action == "click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(f"pyautogui.click({adj_x}, {adj_y})")
                        else:
                            pyautogui_code.append("pyautogui.click()")

                    elif action == "right_click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(
                                f"pyautogui.rightClick({adj_x}, {adj_y})"
                            )
                        else:
                            pyautogui_code.append("pyautogui.rightClick()")

                    elif action == "middle_click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(
                                f"pyautogui.middleClick({adj_x}, {adj_y})"
                            )
                        else:
                            pyautogui_code.append("pyautogui.middleClick()")

                    elif action == "double_click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(
                                f"pyautogui.doubleClick({adj_x}, {adj_y})"
                            )
                        else:
                            pyautogui_code.append("pyautogui.doubleClick()")

                    elif action == "triple_click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(
                                f"pyautogui.tripleClick({adj_x}, {adj_y})"
                            )
                        else:
                            pyautogui_code.append("pyautogui.tripleClick()")

                    elif action == "type":
                        text = args.get("text", "")
                        
                        try:
                            text = text.encode('latin-1', 'backslashreplace').decode('unicode_escape')
                        except Exception as e:
                            logger.error(f"Failed to unescape text: {e}")

                        logger.info(f"Pyautogui code[before rewrite]: {text}")
                        
                        result = ""
                        for char in text:
                            if char == '\n':
                                result += "pyautogui.press('enter')\n"
                            elif char == "'":
                                result += 'pyautogui.press("\'")\n'
                            elif char == '\\':
                                result += "pyautogui.press('\\\\')\n"
                            elif char == '"':
                                result += "pyautogui.press('\"')\n"
                            else:
                                result += f"pyautogui.press('{char}')\n"
                                
                        pyautogui_code.append(result)
                        logger.info(f"Pyautogui code[after rewrite]: {pyautogui_code}")
                    

                    elif action == "key":
                        keys = _clean_keys(args.get("keys", []))

                        keys_str = ", ".join([f"'{key}'" for key in keys])
                        if len(keys) > 1:
                            pyautogui_code.append(f"pyautogui.hotkey({keys_str})")
                        else:
                            pyautogui_code.append(f"pyautogui.press({keys_str})")

                    elif action == "key_down":
                        keys = _clean_keys(args.get("keys", []))
                        for k in keys:
                            pyautogui_code.append(f"pyautogui.keyDown('{k}')")

                    elif action == "key_up":
                        keys = _clean_keys(args.get("keys", []))
                        for k in reversed(keys):
                            pyautogui_code.append(f"pyautogui.keyUp('{k}')")

                    elif action == "scroll":
                        pixels = args.get("pixels", 0)
                        pyautogui_code.append(f"pyautogui.scroll({pixels})")

                    elif action == "wait":
                        pyautogui_code.append("WAIT")

                    elif action == "terminate":
                        # Termination should respect status:
                        # - success -> DONE
                        # - failure -> FAIL
                        # Backward compatible: missing status defaults to success.
                        status = args.get("status", "success")
                        if str(status).lower() == "failure":
                            pyautogui_code.append("FAIL")
                        else:
                            pyautogui_code.append("DONE")

                    elif action == "mouse_move":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(
                                f"pyautogui.moveTo({adj_x}, {adj_y})"
                            )
                        else:
                            pyautogui_code.append("pyautogui.moveTo(0, 0)")

                    elif action == "left_click_drag":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            duration = args.get("duration", 0.5)
                            pyautogui_code.append(
                                f"pyautogui.dragTo({adj_x}, {adj_y}, duration={duration})"
                            )
                        else:
                            pyautogui_code.append("pyautogui.dragTo(0, 0)")
            except (json.JSONDecodeError, KeyError) as e:
                logger.error(f"Failed to parse tool call: {e}")

        lines = response.split("\n")
        inside_tool_call = False
        current_tool_call: List[str] = []

        for line in lines:
            line = line.strip()
            if not line:
                continue

            if line.lower().startswith(("action:")):
                if not low_level_instruction:
                    low_level_instruction = line.split("Action:")[-1].strip()
                continue

            if line.startswith("<tool_call>"):
                inside_tool_call = True
                continue
            elif line.startswith("</tool_call>"):
                if current_tool_call:
                    process_tool_call("\n".join(current_tool_call))
                    current_tool_call = []
                inside_tool_call = False
                continue

            if inside_tool_call:
                current_tool_call.append(line)
                continue

            if line.startswith("{") and line.endswith("}"):
                try:
                    json_obj = json.loads(line)
                    if "name" in json_obj and "arguments" in json_obj:
                        process_tool_call(line)
                except json.JSONDecodeError:
                    pass

        if current_tool_call:
            process_tool_call("\n".join(current_tool_call))

        if not low_level_instruction and len(pyautogui_code) > 0:
            first_action = pyautogui_code[0]
            if "." in first_action:
                action_type = first_action.split(".", 1)[1].split("(", 1)[0]
            else:
                action_type = first_action.lower()
            low_level_instruction = f"Performing {action_type} action"

        return low_level_instruction, pyautogui_code



    def _predict_s1(self, instruction, obs, processed_b64):
        messages = [{"role": "system", "content": S1_SYSTEM_PROMPT.format(password=self.password)}]
        
        # Reconstruct History Logic for S1 mode
        history_step_texts = []
        
        for i in range(len(self.actions)):
            cot = self.cots[i] if i < len(self.cots) else {}
            
            # Step Content string
            step_content = S1_STEP_TEMPLATE.format(step_num=i+1) + S1_ACTION_HISTORY_TEMPLATE.format(action=cot.get('action', ''))
            
            if i > len(self.actions) - self.max_history_turns:
                # Recent history: Add User(Image) and Assistant(Text)
                if i < len(self.screenshots) - 1: # Screenshot exists for this step
                    img = self.screenshots[i]
                    messages.append({
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}}
                        ]
                    })
                messages.append({"role": "assistant", "content": step_content})
            else:
                # Old history: Collect text
                history_step_texts.append(step_content)
                # If this is the last step before the recent window, flush collected texts
                if i == len(self.actions) - self.max_history_turns:
                    messages.append({
                        "role": "assistant",
                        "content": "\n".join(history_step_texts)
                    })

        # Current
        messages.append({
            "role": "user", 
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{processed_b64}"}},
                {"type": "text", "text": S1_INSTRUTION_TEMPLATE.format(instruction=instruction)}
            ]
        })

        response = self.call_llm({
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens
        })
        
        low_level, codes, cot_data = self._parse_response_s1(response)
        
        self.observations.append(obs)
        self.cots.append(cot_data)
        self.actions.append(low_level)
        self.responses.append(response)
        
        return response, codes


    def _parse_response_s1(self, response):
        sections = {}
        # Simple Regex Parsing
        for key, pattern in [
            ('observation', r'#{1,2}\s*Observation\s*:?[\n\r]+(.*?)(?=^#{1,2}\s|$)'),
            ('thought', r'#{1,2}\s*Thought\s*:?[\n\r]+(.*?)(?=^#{1,2}\s|$)'),
            ('action', r'#{1,2}\s*Action\s*:?[\n\r]+(.*?)(?=^#{1,2}\s|$)')
        ]:
            m = re.search(pattern, response, re.DOTALL | re.MULTILINE)
            if m: sections[key] = m.group(1).strip()
            
        code_blocks = re.findall(r'```(?:code|python)?\s*(.*?)\s*```', response, re.DOTALL | re.IGNORECASE)
        code = code_blocks[-1].strip() if code_blocks else "FAIL"
        
        sections['code'] = code
        
        # Post-process code
        if "computer.terminate" in code:
             final_code = ["DONE"] if "success" in code.lower() else ["FAIL"]
        elif "computer.wait" in code:
             final_code = ["WAIT"]
        else:
             # Project coordinates
             code = project_coordinate_to_absolute_scale(
                 code, 
                 self.screen_size[0], 
                 self.screen_size[1], 
                 self.coordinate_type,
                 self.resize_factor
             )
             logger.info(f"[rewrite before]: {code}")
             final_code = [rewrite_pyautogui_text_inputs(code)]
             logger.info(f"[rewrite after]: {final_code}")

        return sections.get('action', 'Acting'), final_code, sections


    @staticmethod
    def _should_giveup_on_context_error(e):
        """对于 context length 相关的错误，立即放弃重试，交给外层处理"""
        error_str = str(e)
        return "Too Large" in error_str or "context_length_exceeded" in error_str or "413" in error_str

    @backoff.on_exception(backoff.constant, Exception, interval=30, max_tries=10, giveup=_should_giveup_on_context_error.__func__)
    def call_llm(self, payload):
        """Unified OpenAI-compatible API call"""
        # Get env vars
        base_url = os.environ.get("OPENAI_BASE_URL", "url-xxx")
        api_key = os.environ.get("OPENAI_API_KEY", "sk-xxx")

        client = openai.OpenAI(base_url=base_url, api_key=api_key)
        
        messages = payload["messages"]
        log_messages(messages, "LLM Request")
        
        params = {
            "model": payload["model"],
            "messages": messages,
            "max_tokens": payload["max_tokens"],
            "temperature": self.temperature,
            "top_p": self.top_p
        }
        
        try:
            resp = client.chat.completions.create(**params)
            content = resp.choices[0].message.content
            logger.info(f"LLM Response:\n{content}")
            return content
        except Exception as e:
            logger.error(f"LLM Call failed: {e}")
            raise e
