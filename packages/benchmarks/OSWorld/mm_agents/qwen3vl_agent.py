import base64
import json
import logging
import time
import os
from io import BytesIO
from typing import Dict, List, Tuple

from http import HTTPStatus
import dashscope
from dashscope import MultiModalConversation
import backoff
import openai
from PIL import Image
from requests.exceptions import SSLError
from google.api_core.exceptions import (
    InvalidArgument,
    ResourceExhausted,
    InternalServerError,
    BadRequest,
)
from mm_agents.utils.qwen_vl_utils import smart_resize


logger = None

MAX_RETRY_TIMES = 5


def encode_image(image_content):
    return base64.b64encode(image_content).decode("utf-8")


def process_image(image_bytes):
    """
    Process an image for Qwen VL models (thinking variant).
    Uses a tighter resize cap consistent with the thinking DUN agent.
    """
    image = Image.open(BytesIO(image_bytes))
    width, height = image.size

    resized_height, resized_width = smart_resize(
        height=height,
        width=width,
        factor=32,
        max_pixels=16 * 16 * 4 * 12800,
    )

    image = image.resize((resized_width, resized_height))

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    processed_bytes = buffer.getvalue()

    return base64.b64encode(processed_bytes).decode("utf-8")


class Qwen3VLAgent:

    def __init__(
        self,
        platform: str = "ubuntu",
        model: str = "qwen3-vl",
        max_tokens: int = 32768,
        top_p: float = 0.9,
        temperature: float = 0.0,
        action_space: str = "pyautogui",
        observation_type: str = "screenshot",
        history_n: int = 4,
        add_thought_prefix: bool = False,
        coordinate_type: str = "relative",
        api_backend: str = "dashscope",  # "openai" or "dashscope"
        enable_thinking: bool = False,  # Enable thinking mode for DashScope
        thinking_budget: int = 32768,  # Token budget for reasoning
    ):
        self.platform = platform
        self.model = model
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        self.history_n = history_n
        self.add_thought_prefix = add_thought_prefix
        self.coordinate_type = coordinate_type
        self.api_backend = api_backend
        self.enable_thinking = enable_thinking
        self.thinking_budget = thinking_budget

        assert action_space in ["pyautogui"], "Invalid action space"
        assert observation_type in ["screenshot"], "Invalid observation type"
        assert api_backend in ["openai", "dashscope"], "Invalid API backend, must be 'openai' or 'dashscope'"

        self.thoughts = []
        self.actions = []
        self.observations = []
        self.responses = []
        self.screenshots = []

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Predict the next action(s) based on the current observation.
        Returns (response, pyautogui_code).
        """
        screenshot_bytes = obs["screenshot"]

        image = Image.open(BytesIO(screenshot_bytes))
        width, height = image.size
        print(f"Original screen resolution: {width}x{height}")

        processed_image = process_image(screenshot_bytes)
        processed_img = Image.open(
            BytesIO(base64.b64decode(processed_image))
        )
        processed_width, processed_height = processed_img.size
        print(
            "Processed image resolution: "
            f"{processed_width}x{processed_height}"
        )

        self.screenshots.append(processed_image)

        current_step = len(self.actions)
        history_start_idx = max(0, current_step - self.history_n)

        previous_actions = []
        for i in range(history_start_idx):
            if i < len(self.actions):
                previous_actions.append(f"Step {i+1}: {self.actions[i]}")
        previous_actions_str = (
            "\n".join(previous_actions) if previous_actions else "None"
        )

        description_prompt_lines = [
            "Use a mouse and keyboard to interact with a computer, and take screenshots.",
            "* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.",
            "* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try wait and taking another screenshot.",
            (
                f"* The screen's resolution is {processed_width}x{processed_height}."
                if self.coordinate_type == "absolute"
                else "* The screen's resolution is 1000x1000."
            ),
            "* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.",
            "* If you tried clicking on a program or link but it failed to load even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.",
            "* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
        ]
        description_prompt = "\n".join(description_prompt_lines)

        action_description_prompt = """
* `key`: Performs key down presses on the arguments passed in order, then performs key releases in reverse order.
* `type`: Type a string of text on the keyboard.
* `mouse_move`: Move the cursor to a specified (x, y) pixel coordinate on the screen.
* `left_click`: Click the left mouse button at a specified (x, y) pixel coordinate on the screen.
* `left_click_drag`: Click and drag the cursor to a specified (x, y) pixel coordinate on the screen.
* `right_click`: Click the right mouse button at a specified (x, y) pixel coordinate on the screen.
* `middle_click`: Click the middle mouse button at a specified (x, y) pixel coordinate on the screen.
* `double_click`: Double-click the left mouse button at a specified (x, y) pixel coordinate on the screen.
* `triple_click`: Triple-click the left mouse button at a specified (x, y) pixel coordinate on the screen (simulated as double-click since it's the closest action).
* `scroll`: Performs a scroll of the mouse scroll wheel.
* `hscroll`: Performs a horizontal scroll (mapped to regular scroll).
* `wait`: Wait specified seconds for the change to happen.
* `terminate`: Terminate the current task and report its completion status.
* `answer`: Answer a question.
        """

        tools_def = {
            "type": "function", 
            "function": {
                "name_for_human": "computer_use", 
                "name": "computer_use", 
                "description": description_prompt,
                "parameters": {
                    "properties": {
                        "action": {
                            "description": action_description_prompt,
                            "enum": ["key", "type", "mouse_move", "left_click", "left_click_drag", 
                                     "right_click", "middle_click", "double_click", "scroll", "wait", "terminate"], 
                            "type": "string"
                        },
                        "keys": {"description": "Required only by `action=key`.", "type": "array"}, 
                        "text": {"description": "Required only by `action=type`.", "type": "string"}, 
                        "coordinate": {"description": "The x,y coordinates for mouse actions.", "type": "array"}, 
                        "pixels": {"description": "The amount of scrolling.", "type": "number"}, 
                        "time": {"description": "The seconds to wait.", "type": "number"}, 
                        "status": {
                            "description": "The status of the task.", 
                            "type": "string", 
                            "enum": ["success", "failure"]
                        }
                    }, 
                    "required": ["action"], 
                    "type": "object"
                }, 
                "args_format": "Format the arguments as a JSON object."
            }
        }

        system_prompt = """# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
""" + json.dumps(tools_def) + """
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

# Response format

Response format for every step:
1) Action: a short imperative describing what to do in the UI.
2) A single <tool_call>...</tool_call> block containing only the JSON: {"name": <function-name>, "arguments": <args-json-object>}.

Rules:
- Output exactly in the order: Action, <tool_call>.
- Be brief: one sentence for Action.
- Do not output anything else outside those parts.
- If finishing, use action=terminate in the tool call."""

        instruction_prompt = f"""
Please generate the next move according to the UI screenshot, instruction and previous actions.

Instruction: {instruction}

Previous actions:
{previous_actions_str}"""

        messages = [
            {
                "role": "system",
                "content": [
                    {"type": "text", "text": system_prompt},
                ],
            }
        ]

        history_len = min(self.history_n, len(self.responses))
        if history_len > 0:
            history_responses = self.responses[-history_len:]
            history_screenshots = self.screenshots[-history_len - 1:-1]

            for idx in range(history_len):
                if idx < len(history_screenshots):
                    screenshot_b64 = history_screenshots[idx]
                    if idx == 0:
                        img_url = f"data:image/png;base64,{screenshot_b64}"
                        messages.append(
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": img_url},
                                    },
                                    {"type": "text", "text": instruction_prompt},
                                ],
                            }
                        )
                    else:
                        img_url = f"data:image/png;base64,{screenshot_b64}"
                        messages.append(
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": img_url},
                                    }
                                ],
                            }
                        )

                messages.append(
                    {
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": f"{history_responses[idx]}"},
                        ],
                    }
                )

            curr_img_url = f"data:image/png;base64,{processed_image}"
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": curr_img_url},
                        }
                    ],
                }
            )
        else:
            curr_img_url = f"data:image/png;base64,{processed_image}"
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": curr_img_url},
                        },
                        {"type": "text", "text": instruction_prompt},
                    ],
                }
            )

        # Debug: save messages before sending to model
        try:
            draft_dir = "./draft/message_cache"
            os.makedirs(draft_dir, exist_ok=True)
            message_file_path = os.path.join(
                draft_dir, f"messages_step_{current_step}.json"
            )
            with open(message_file_path, "w") as f:
                json.dump(messages, f)
        except Exception as _e:  # do not fail prediction due to debug IO
            pass

        response = self.call_llm(
            {
                "model": self.model,
                "messages": messages,
                "max_tokens": self.max_tokens,
                "top_p": self.top_p,
                "temperature": self.temperature,
            },
            self.model,
        )

        logger.info(f"Qwen3VL Output: {response}")

        self.responses.append(response)

        low_level_instruction, pyautogui_code = self.parse_response(
            response,
            width,
            height,
            processed_width,
            processed_height,
        )

        logger.info(f"Low level instruction: {low_level_instruction}")
        logger.info(f"Pyautogui code: {pyautogui_code}")

        self.actions.append(low_level_instruction)

        return response, pyautogui_code

    def parse_response(
        self,
        response: str,
        original_width: int = None,
        original_height: int = None,
        processed_width: int = None,
        processed_height: int = None,
    ) -> Tuple[str, List[str]]:
        """
        Parse LLM response and convert it to low level action and pyautogui code.
        """
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

                    if action == "left_click":
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

                    elif action == "type":
                        text = args.get("text", "")
                        pyautogui_code.append(f"pyautogui.typewrite('{text}')")

                    elif action == "key":
                        keys = args.get("keys", [])
                        if isinstance(keys, list):
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
                            keys = cleaned_keys

                        keys_str = ", ".join([f"'{key}'" for key in keys])
                        if len(keys) > 1:
                            pyautogui_code.append(f"pyautogui.hotkey({keys_str})")
                        else:
                            pyautogui_code.append(f"pyautogui.press({keys_str})")

                    elif action == "scroll":
                        pixels = args.get("pixels", 0)
                        pyautogui_code.append(f"pyautogui.scroll({pixels})")

                    elif action == "wait":
                        pyautogui_code.append("WAIT")

                    elif action == "terminate":
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
            action_type = pyautogui_code[0].split(".", 1)[1].split("(", 1)[0]
            low_level_instruction = f"Performing {action_type} action"

        return low_level_instruction, pyautogui_code

    @staticmethod
    def _to_dashscope_messages(messages):
        """
        Convert messages built for OpenAI compat into DashScope MultiModalConversation format.
        - "text" part  -> {"text": "..."}
        - "image_url"  -> {"image": "<url-or-data-uri>"}
        - "video_url"  -> {"video": "<url-or-data-uri>"}
        """
        ds_msgs = []
        for m in messages:
            role = m.get("role", "")
            parts = m.get("content", [])
            ds_content = []
            for p in parts:
                ptype = p.get("type")
                if ptype == "text":
                    ds_content.append({"text": p.get("text", "")})
                elif ptype == "image_url":
                    url = (p.get("image_url") or {}).get("url", "")
                    # DashScope accepts http(s), file://, or data:image/*; keep as-is
                    ds_content.append({"image": url})
                elif ptype == "video_url":
                    url = (p.get("video_url") or {}).get("url", "")
                    ds_content.append({"video": url})
                else:
                    # If you ever pass raw assistant strings (no parts), tolerate it
                    if isinstance(p, str):
                        ds_content.append({"text": p})
            # Also tolerate plain-string content (rare)
            if not ds_content and isinstance(m.get("content"), str):
                ds_content = [{"text": m["content"]}]
            ds_msgs.append({"role": role, "content": ds_content})
        return ds_msgs

    @staticmethod
    def _extract_text_from_dashscope_response(resp):
        """Join all 'text' parts from the first choice, including reasoning if present."""
        if hasattr(resp, "output"):
            out = resp.output
        else:
            out = resp.get("output") if isinstance(resp, dict) else None
        if not out:
            return None
        choices = getattr(out, "choices", None) if not isinstance(out, dict) else out.get("choices")
        if not choices:
            return None
        msg = getattr(choices[0], "message", None) if not isinstance(choices[0], dict) else choices[0].get("message")
        if not msg:
            return None
        content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content", [])
        if not content:
            return None
        
        # Extract reasoning content if present (for thinking models)
        reasoning_content = getattr(msg, "reasoning_content", None) if not isinstance(msg, dict) else msg.get("reasoning_content", None)
        
        content_text = "".join(part.get("text", "") for part in content if isinstance(part, dict) and "text" in part)
        
        # Format with thinking tags if reasoning exists
        if reasoning_content is not None:
            return f"<think>\n{reasoning_content}\n</think>\n\n{content_text}"
        else:
            return content_text

    @backoff.on_exception(
        backoff.constant,
        (
            SSLError,
            openai.RateLimitError,
            openai.BadRequestError,
            openai.InternalServerError,
            InvalidArgument,
            ResourceExhausted,
            InternalServerError,
            BadRequest,
        ),
        interval=30,
        max_tries=5,
    )
    def call_llm(self, payload, model):
        messages = payload["messages"]

        if self.api_backend == "openai":
            return self._call_llm_openai(messages, model)
        elif self.api_backend == "dashscope":
            return self._call_llm_dashscope(messages, model)
        else:
            raise ValueError(f"Unknown API backend: {self.api_backend}")

    def _call_llm_openai(self, messages, model):
        """Call LLM using OpenAI SDK (compatible with OpenAI-compatible endpoints)."""
        base_url = os.environ.get("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        api_key = os.environ.get("OPENAI_API_KEY", "sk-123")
        client = openai.OpenAI(base_url=base_url, api_key=api_key)

        for attempt in range(1, MAX_RETRY_TIMES + 1):
            logger.info(f"[OpenAI] Generating content with model: {model} (attempt {attempt}/{MAX_RETRY_TIMES})")
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    max_tokens=self.max_tokens,
                    # temperature=self.temperature,
                    # top_p=self.top_p,
                )
                return response.choices[0].message.content
            except Exception as e:
                logger.error(f"[OpenAI] Error calling model: {e}")
                if attempt < MAX_RETRY_TIMES:
                    time.sleep(5)
                    continue
                break
        return ""

    def _call_llm_dashscope(self, messages, model):
        """Call LLM using DashScope SDK."""
        dashscope.base_http_api_url = os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1")
        dashscope.api_key = os.environ.get("DASHSCOPE_API_KEY", "sk-123")

        # Convert message schema
        ds_messages = self._to_dashscope_messages(messages)

        # Retry loop
        last_err = None
        for attempt in range(1, MAX_RETRY_TIMES + 1):
            thinking_status = f" (thinking={self.enable_thinking})" if self.enable_thinking else ""
            logger.info(f"[DashScope] Generating content with model: {model}, thinking_status: {thinking_status} (attempt {attempt}/{MAX_RETRY_TIMES})")
            try:
                # Build API call parameters
                call_params = {
                    "model": model,
                    "messages": ds_messages,
                    "max_tokens": self.max_tokens,
                    # "temperature": self.temperature,
                    # "top_p": self.top_p,
                    "vl_high_resolution_images": True,
                }
                
                # Add thinking parameters if enabled
                if self.enable_thinking:
                    call_params["enable_thinking"] = True
                    call_params["thinking_budget"] = self.thinking_budget
                
                resp = MultiModalConversation.call(**call_params)

                if getattr(resp, "status_code", None) not in (None, HTTPStatus.OK):
                    code = getattr(resp, "code", "")
                    msg = getattr(resp, "message", "")
                    reqid = getattr(resp, "request_id", "")
                    logger.warning(f"[DashScope] non-OK response (id={reqid}): {code} {msg}")
                    last_err = RuntimeError(f"DashScope status {resp.status_code}: {code} {msg}")
                    time.sleep(1.5 * attempt)
                    continue

                text = self._extract_text_from_dashscope_response(resp)
                if not text:
                    raise ValueError("DashScope response has no text content")
                return text

            except Exception as e:
                last_err = e
                logger.error(f"[DashScope] call failed: {e}")
                if attempt < MAX_RETRY_TIMES:
                    time.sleep(1.5 * attempt)
                    continue
                break

        if last_err:
            raise last_err
        return ""

    def reset(self, _logger=None):
        global logger
        logger = (
            _logger if _logger is not None
            else logging.getLogger("desktopenv.qwen3vl_agent")
        )

        self.thoughts = []
        self.action_descriptions = (
            [] if hasattr(self, "action_descriptions") else []
        )
        self.actions = []
        self.observations = []
        self.responses = []
        self.screenshots = []


