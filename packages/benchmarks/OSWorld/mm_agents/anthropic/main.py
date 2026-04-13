import base64
import os
import time
from typing import Any, cast, Optional, Dict
from PIL import Image
import io

from anthropic import (
    Anthropic,
    AnthropicBedrock,
    AnthropicVertex,
    APIError,
    APIResponseValidationError,
    APIStatusError,
)
from anthropic.types.beta import (
    BetaMessageParam,
    BetaTextBlockParam,
)
from .utils import COMPUTER_USE_BETA_FLAG, PROMPT_CACHING_BETA_FLAG,SYSTEM_PROMPT, SYSTEM_PROMPT_WINDOWS, APIProvider, PROVIDER_TO_DEFAULT_MODEL_NAME, get_model_name
from .utils import _response_to_params, _inject_prompt_caching, _maybe_filter_to_n_most_recent_images

import logging
logger = logging.getLogger("desktopenv.agent")

# MAX_HISTORY = 10
API_RETRY_TIMES = 500  
API_RETRY_INTERVAL = 5

class AnthropicAgent:
    def __init__(self,
                 platform: str = "Ubuntu",
                 model: str = "claude-sonnet-4-5-20250929",
                 provider: APIProvider = APIProvider.ANTHROPIC,
                 max_tokens: int = 4096,
                 api_key: str = os.environ.get("ANTHROPIC_API_KEY", None),
                 system_prompt_suffix: str = "",
                 only_n_most_recent_images: Optional[int] = 10,
                 action_space: str = "claude_computer_use",
                 screen_size: tuple[int, int] = (1920, 1080),
                 no_thinking: bool = False,
                 use_isp: bool = False,
                 temperature: Optional[float] = None,
                 top_p: Optional[float] = None,
                 *args, **kwargs
                 ):
        self.platform = platform
        self.action_space = action_space
        self.logger = logger
        self.class_name = self.__class__.__name__
        self.model_name = model
        self.provider = provider
        self.max_tokens = max_tokens
        self.api_key = api_key
        self.system_prompt_suffix = system_prompt_suffix
        self.only_n_most_recent_images = only_n_most_recent_images
        self.messages: list[BetaMessageParam] = []
        self.screen_size = screen_size
        self.no_thinking = no_thinking
        self.use_isp = use_isp
        self.temperature = temperature
        self.top_p = top_p
        
        self.resize_factor = (
            screen_size[0] / 1280,  # Assuming 1280 is the base width
            screen_size[1] / 720   # Assuming 720 is the base height
        )
    
    def _get_sampling_params(self):
        """Get sampling parameters (temperature and/or top_p) - let API validate exclusivity"""
        params = {}
        if self.temperature is not None:
            params['temperature'] = self.temperature
        if self.top_p is not None:
            params['top_p'] = self.top_p
        return params

    def add_tool_result(self, tool_call_id: str, result: str, screenshot: bytes = None):
        """Add tool result to message history"""
        tool_result_content = [
            {
                "type": "tool_result",
                "tool_use_id": tool_call_id,
                "content": [{"type": "text", "text": result}]
            }
        ]
        
        # Add screenshot if provided
        if screenshot is not None:
            screenshot_base64 = base64.b64encode(screenshot).decode('utf-8')
            tool_result_content[0]["content"].append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png", 
                    "data": screenshot_base64
                }
            })
        
        self.messages.append({
            "role": "user",
            "content": tool_result_content
        })
    
    def _extract_raw_response_string(self, response) -> str:
        """Extract and concatenate raw response content into a single string."""
        raw_response_str = ""
        if response.content:
            for block in response.content:
                if hasattr(block, 'text') and block.text:
                    raw_response_str += f"[TEXT] {block.text}\n"
                elif hasattr(block, 'thinking') and block.thinking:
                    raw_response_str += f"[THINKING] {block.thinking}\n"
                elif hasattr(block, 'name') and hasattr(block, 'input'):
                    raw_response_str += f"[TOOL_USE] {block.name}: {block.input}\n"
                else:
                    raw_response_str += f"[OTHER] {str(block)}\n"
        return raw_response_str.strip()

    def parse_actions_from_tool_call(self, tool_call: Dict) -> str:
        result = ""
        function_args = (
            tool_call["input"]
        )
        
        action = function_args.get("action")
        if not action:
            action = tool_call.function.name
        action_conversion = {
            "left click": "click",
            "right click": "right_click"
        }
        action = action_conversion.get(action, action)
        
        text = function_args.get("text")
        coordinate = function_args.get("coordinate")
        start_coordinate = function_args.get("start_coordinate")
        scroll_direction = function_args.get("scroll_direction")
        scroll_amount = function_args.get("scroll_amount")
        duration = function_args.get("duration")
        
        # resize coordinates if resize_factor is set
        if coordinate and self.resize_factor:
            coordinate = (
                int(coordinate[0] * self.resize_factor[0]),
                int(coordinate[1] * self.resize_factor[1])
            )
        if start_coordinate and self.resize_factor:
            start_coordinate = (
                int(start_coordinate[0] * self.resize_factor[0]),
                int(start_coordinate[1] * self.resize_factor[1])
            )
        
        if action == "left_mouse_down":
            result += "pyautogui.mouseDown()\n"
        elif action == "left_mouse_up":
            result += "pyautogui.mouseUp()\n"
        
        elif action == "hold_key":
            if not isinstance(text, str):
                raise ValueError(f"{text} must be a string")
            
            keys = text.split('+')
            for key in keys:
                key = key.strip().lower()
                result += f"pyautogui.keyDown('{key}')\n"
            expected_outcome = f"Keys {text} held down."

        # Handle mouse move and drag actions
        elif action in ("mouse_move", "left_click_drag"):
            if coordinate is None:
                raise ValueError(f"coordinate is required for {action}")
            if text is not None:
                raise ValueError(f"text is not accepted for {action}")
            if not isinstance(coordinate, (list, tuple)) or len(coordinate) != 2:
                raise ValueError(f"{coordinate} must be a tuple of length 2")
            if not all(isinstance(i, int) for i in coordinate):
                raise ValueError(f"{coordinate} must be a tuple of ints")
            
            x, y = coordinate[0], coordinate[1]
            if action == "mouse_move":
                result += (
                    f"pyautogui.moveTo({x}, {y}, duration={duration or 0.5})\n"
                )
                expected_outcome = f"Mouse moved to ({x},{y})."
            elif action == "left_click_drag":
                # If start_coordinate is provided, validate and move to start before dragging
                if start_coordinate:
                    if not isinstance(start_coordinate, (list, tuple)) or len(start_coordinate) != 2:
                        raise ValueError(f"{start_coordinate} must be a tuple of length 2")
                    if not all(isinstance(i, int) for i in start_coordinate):
                        raise ValueError(f"{start_coordinate} must be a tuple of ints")
                    start_x, start_y = start_coordinate[0], start_coordinate[1]
                    result += (
                        f"pyautogui.moveTo({start_x}, {start_y}, duration={duration or 0.5})\n"
                    )
                result += (
                    f"pyautogui.dragTo({x}, {y}, duration={duration or 0.5})\n"
                )
                expected_outcome = f"Cursor dragged to ({x},{y})."

        # Handle keyboard actions
        elif action in ("key", "type"):
            if text is None:
                raise ValueError(f"text is required for {action}")
            if coordinate is not None:
                raise ValueError(f"coordinate is not accepted for {action}")
            if not isinstance(text, str):
                raise ValueError(f"{text} must be a string")

            if action == "key":
                key_conversion = {
                    "page_down": "pagedown",
                    "page_up": "pageup",
                    "super_l": "win",
                    "super": "command",
                    "escape": "esc"
                }
                keys = text.split('+')
                for key in keys:
                    key = key.strip().lower()
                    key = key_conversion.get(key, key)
                    result += (f"pyautogui.keyDown('{key}')\n")
                for key in reversed(keys):
                    key = key.strip().lower()
                    key = key_conversion.get(key, key)
                    result += (f"pyautogui.keyUp('{key}')\n")
                expected_outcome = f"Key {key} pressed."
            elif action == "type":
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
                expected_outcome = f"Text {text} written."

        # Handle scroll actions
        elif action == "scroll":
            if text is not None:
                result += (f"pyautogui.keyDown('{text.lower()}')\n")
            if coordinate is None:
                if scroll_direction in ("up", "down"):
                    result += (
                        f"pyautogui.scroll({scroll_amount if scroll_direction == 'up' else -scroll_amount})\n"
                    )
                elif scroll_direction in ("left", "right"):
                    result += (
                        f"pyautogui.hscroll({scroll_amount if scroll_direction == 'right' else -scroll_amount})\n"
                    )
            else:
                if scroll_direction in ("up", "down"):
                    x, y = coordinate[0], coordinate[1]
                    result += (
                        f"pyautogui.scroll({scroll_amount if scroll_direction == 'up' else -scroll_amount}, {x}, {y})\n"
                    )
                elif scroll_direction in ("left", "right"):
                    x, y = coordinate[0], coordinate[1]
                    result += (
                        f"pyautogui.hscroll({scroll_amount if scroll_direction == 'right' else -scroll_amount}, {x}, {y})\n"
                    )
            if text is not None:
                result += (f"pyautogui.keyUp('{text.lower()}')\n")
            expected_outcome = "Scroll action finished"

        # Handle click actions
        elif action in ("left_click", "right_click", "double_click", "middle_click", "left_press", "triple_click"):
            # Handle modifier keys during click if specified
            if text:
                keys = text.split('+')
                for key in keys:
                    key = key.strip().lower()
                    result += f"pyautogui.keyDown('{key}')\n"
            if coordinate is not None:
                x, y = coordinate
                if action == "left_click":
                    result += (f"pyautogui.click({x}, {y})\n")
                elif action == "right_click":
                    result += (f"pyautogui.rightClick({x}, {y})\n")
                elif action == "double_click":
                    result += (f"pyautogui.doubleClick({x}, {y})\n")
                elif action == "middle_click":
                    result += (f"pyautogui.middleClick({x}, {y})\n")
                elif action == "left_press":
                    result += (f"pyautogui.mouseDown({x}, {y})\n")
                    result += ("time.sleep(1)\n")
                    result += (f"pyautogui.mouseUp({x}, {y})\n")
                elif action == "triple_click":
                    result += (f"pyautogui.tripleClick({x}, {y})\n")

            else:
                if action == "left_click":
                    result += ("pyautogui.click()\n")
                elif action == "right_click":
                    result += ("pyautogui.rightClick()\n")
                elif action == "double_click":
                    result += ("pyautogui.doubleClick()\n")
                elif action == "middle_click":
                    result += ("pyautogui.middleClick()\n")
                elif action == "left_press":
                    result += ("pyautogui.mouseDown()\n")
                    result += ("time.sleep(1)\n")
                    result += ("pyautogui.mouseUp()\n")
                elif action == "triple_click":
                    result += ("pyautogui.tripleClick()\n")
            # Release modifier keys after click
            if text:
                keys = text.split('+')
                for key in reversed(keys):
                    key = key.strip().lower()
                    result += f"pyautogui.keyUp('{key}')\n"
            expected_outcome = "Click action finished"
            
        elif action == "wait":
            result += "pyautogui.sleep(0.5)\n"
            expected_outcome = "Wait for 0.5 seconds"
        elif action == "fail":
            result += "FAIL"
            expected_outcome = "Finished"
        elif action == "done":
            result += "DONE"
            expected_outcome = "Finished"
        elif action == "call_user":
            result += "CALL_USER"
            expected_outcome = "Call user"
        elif action == "screenshot":
            result += "pyautogui.sleep(0.1)\n"
            expected_outcome = "Screenshot taken"
        else:
            raise ValueError(f"Invalid action: {action}")
        
        return result
            
    def predict(self, task_instruction: str, obs: Dict = None, system: Any = None):
        system = BetaTextBlockParam(
            type="text",
            text=f"{SYSTEM_PROMPT_WINDOWS if self.platform == 'Windows' else SYSTEM_PROMPT}{' ' + self.system_prompt_suffix if self.system_prompt_suffix else ''}"
        )
        
        # resize screenshot if resize_factor is set
        if obs and "screenshot" in obs:
            # Convert bytes to PIL Image
            screenshot_bytes = obs["screenshot"]
            screenshot_image = Image.open(io.BytesIO(screenshot_bytes))
            
            # Store original unresized screenshot for zoom processing
            obs["screenshot_original"] = screenshot_bytes
            
            # Calculate new size based on resize factor
            new_width, new_height = 1280, 720
            
            # Resize the image
            resized_image = screenshot_image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            
            # Convert back to bytes
            output_buffer = io.BytesIO()
            resized_image.save(output_buffer, format='PNG')
            obs["screenshot"] = output_buffer.getvalue()
            

        if not self.messages:
            
            init_screenshot = obs
            init_screenshot_base64 = base64.b64encode(init_screenshot["screenshot"]).decode('utf-8')
            self.messages.append({
                "role": "user",
                "content": [
                    {
                    "type": "image",
                    "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": init_screenshot_base64,
                        },
                    },
                    {"type": "text", "text": task_instruction},
                ]
            })
            
        # Add tool_result for ALL tool_use blocks in the last message
        if self.messages:
            last_message_content = self.messages[-1]["content"]
            tool_use_blocks = [block for block in last_message_content if block.get("type") == "tool_use"]
            
            for i, tool_block in enumerate(tool_use_blocks):
                tool_input = tool_block.get("input", {})
                action = tool_input.get("action")
                is_last_tool = i == len(tool_use_blocks) - 1
                
                include_screenshot = None
                
                if obs:
                    if action == "screenshot":
                        # Screenshot action always gets regular screenshot
                        include_screenshot = obs.get("screenshot")
                    elif is_last_tool:
                        # Auto-screenshot: last tool gets regular screenshot (unless it's zoom, handled above)
                        include_screenshot = obs.get("screenshot")
                
                self.add_tool_result(
                    tool_block["id"],
                    f"Success",
                    screenshot=include_screenshot
                )
            
        enable_prompt_caching = False
        betas = [COMPUTER_USE_BETA_FLAG]
        
        # Add interleaved thinking beta if ISP is requested
        if self.use_isp:
            betas.append("interleaved-thinking-2025-05-14")
            logger.info(f"Added interleaved thinking beta. Betas: {betas}")
            
        image_truncation_threshold = 10
        if self.provider == APIProvider.ANTHROPIC:
            client = Anthropic(api_key=self.api_key, max_retries=4).with_options(
                default_headers={"anthropic-beta": COMPUTER_USE_BETA_FLAG}
            )
            enable_prompt_caching = True
        elif self.provider == APIProvider.VERTEX:
            client = AnthropicVertex()
        elif self.provider == APIProvider.BEDROCK:
            client = AnthropicBedrock(
                # Authenticate by either providing the keys below or use the default AWS credential providers, such as
                # using ~/.aws/credentials or the "AWS_SECRET_ACCESS_KEY" and "AWS_ACCESS_KEY_ID" environment variables.
                aws_access_key=os.getenv('AWS_ACCESS_KEY_ID'),
                aws_secret_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
                # aws_region changes the aws region to which the request is made. By default, we read AWS_REGION,
                # and if that's not present, we default to us-east-1. Note that we do not read ~/.aws/config for the region.
                aws_region=os.getenv('AWS_DEFAULT_REGION'),
            )

        if enable_prompt_caching:
            betas.append(PROMPT_CACHING_BETA_FLAG)
            _inject_prompt_caching(self.messages)
            image_truncation_threshold = 20
            system["cache_control"] = {"type": "ephemeral"}

        if self.only_n_most_recent_images:
            _maybe_filter_to_n_most_recent_images(
                self.messages,
                self.only_n_most_recent_images,
                min_removal_threshold=image_truncation_threshold,
            )

        # Configure tool settings - use modern computer tool for all models
        tool_config = {
            'name': 'computer', 
            'type': 'computer_20250124', 
            'display_width_px': 1280, 
            'display_height_px': 720, 
            'display_number': 1
        }
        
        tools = [
            tool_config,
        ] if self.platform == 'Ubuntu' else [
            tool_config,
        ]
        
        # Configure thinking mode based on user preferences
        if self.no_thinking:
            # Disable thinking mode - omit the thinking parameter
            extra_body = {}
            actual_max_tokens = self.max_tokens  # Use default when no thinking
            logger.info("Thinking mode: DISABLED")
        else:
            # Enable thinking mode (regular or interleaved)
            # Use consistent 2048 budget for both regular and ISP thinking
            budget_tokens = 2048
            
            # For regular thinking: max_tokens > budget_tokens (API requirement)
            # For ISP: budget_tokens can exceed max_tokens (represents total across all thinking blocks)
            if self.max_tokens <= budget_tokens:
                required_max_tokens = budget_tokens + 500  # Give some headroom
                logger.warning(f"Regular thinking requires max_tokens > budget_tokens. Increasing max_tokens from {self.max_tokens} to {required_max_tokens}")
                actual_max_tokens = required_max_tokens
            else:
                actual_max_tokens = self.max_tokens
            
            extra_body = {
                "thinking": {"type": "enabled", "budget_tokens": budget_tokens}
            }
            if self.use_isp:
                logger.info("Thinking mode: INTERLEAVED SCRATCHPAD (ISP)")
            else:
                logger.info("Thinking mode: REGULAR SCRATCHPAD")

        try:
            response = None
            
            for attempt in range(API_RETRY_TIMES):
                try:
                    response = client.beta.messages.create(
                        max_tokens=actual_max_tokens,
                        messages=self.messages,
                        model=get_model_name(self.provider, self.model_name),
                        system=[system],
                        tools=tools,
                        betas=betas,
                        extra_body=extra_body,
                        **self._get_sampling_params()
                    )
                    
                    logger.info(f"Response: {response}")
                    break  
                except (APIError, APIStatusError, APIResponseValidationError) as e:
                    error_msg = str(e)
                    logger.warning(f"Anthropic API error (attempt {attempt+1}/{API_RETRY_TIMES}): {error_msg}")
                    
                    if "25000000" in error_msg or "Member must have length less than or equal to" in error_msg:
                        logger.warning("Detected 25MB limit error, automatically reducing image count")
                        current_image_count = self.only_n_most_recent_images
                        new_image_count = max(1, current_image_count // 2)  # Keep at least 1 image
                        self.only_n_most_recent_images = new_image_count
                        
                        _maybe_filter_to_n_most_recent_images(
                            self.messages,
                            new_image_count,
                            min_removal_threshold=image_truncation_threshold,
                        )
                        logger.info(f"Image count reduced from {current_image_count} to {new_image_count}")
                    
                    if attempt < API_RETRY_TIMES - 1:
                        time.sleep(API_RETRY_INTERVAL)
                    else:
                        raise  # All attempts failed, raise exception to enter existing except logic

        except (APIError, APIStatusError, APIResponseValidationError) as e:
            logger.exception(f"Anthropic API error: {str(e)}")
            try:
                logger.warning("Retrying with backup API key...")

                backup_client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY_BACKUP"), max_retries=4).with_options(
                    default_headers={"anthropic-beta": COMPUTER_USE_BETA_FLAG}
                )
                response = backup_client.beta.messages.create(
                    max_tokens=actual_max_tokens,
                    messages=self.messages,
                    model=get_model_name(self.provider, self.model_name),
                    system=[system],
                    tools=tools,
                    betas=betas,
                    extra_body=extra_body,
                    **self._get_sampling_params()
                )
                
                logger.info("Successfully used backup API key")
            except Exception as backup_e:
                backup_error_msg = str(backup_e)
                logger.exception(f"Backup API call also failed: {backup_error_msg}")
                
                # Check if backup API also has 25MB limit error
                if "25000000" in backup_error_msg or "Member must have length less than or equal to" in backup_error_msg:
                    logger.warning("Backup API also encountered 25MB limit error, further reducing image count")
                    # Reduce image count by half again
                    current_image_count = self.only_n_most_recent_images
                    new_image_count = max(1, current_image_count // 2)  # Keep at least 1 image
                    self.only_n_most_recent_images = new_image_count
                    
                    # Reapply image filtering
                    _maybe_filter_to_n_most_recent_images(
                        self.messages,
                        new_image_count,
                        min_removal_threshold=image_truncation_threshold,
                    )
                    logger.info(f"Backup API image count reduced from {current_image_count} to {new_image_count}")
                
                return None, None

        except Exception as e:
            logger.exception(f"Error in Anthropic API: {str(e)}")
            return None, None

        if response is None:
            logger.error("Response is None after API call - this should not happen")
            return None, None

        response_params = _response_to_params(response)
        logger.info(f"Received response params: {response_params}")

        # Convert raw response to concatenated string for trajectory logging
        raw_response_str = self._extract_raw_response_string(response)

        # Store response in message history
        self.messages.append({
            "role": "assistant",
            "content": response_params
        })

        max_parse_retry = 3
        for parse_retry in range(max_parse_retry):
            actions: list[Any] = []
            reasonings: list[str] = []
            try:
                for content_block in response_params:
                    if content_block["type"] == "tool_use":
                        actions.append({
                            "name": content_block["name"],
                            "input": cast(dict[str, Any], content_block["input"]),
                            "id": content_block["id"],
                            "action_type": content_block.get("type"),
                            "command": self.parse_actions_from_tool_call(content_block),
                            "raw_response": raw_response_str  # Add raw response to each action
                        })
                    elif content_block["type"] == "text":
                        reasonings.append(content_block["text"])
                if isinstance(reasonings, list) and len(reasonings) > 0:
                    reasonings = reasonings[0]
                else:
                    reasonings = ""
                
                # Check if the model indicated the task is infeasible
                if raw_response_str and "[INFEASIBLE]" in raw_response_str:
                    logger.info("Detected [INFEASIBLE] pattern in response, triggering FAIL action")
                    # Override actions with FAIL
                    actions = [{
                        "action_type": "FAIL",
                        "raw_response": raw_response_str
                    }]
                
                logger.info(f"Received actions: {actions}")
                logger.info(f"Received reasonings: {reasonings}")
                if len(actions) == 0:
                    actions = [{
                        "action_type": "DONE",
                        "raw_response": raw_response_str
                    }]
                return reasonings, actions
            except Exception as e:
                logger.warning(f"parse_actions_from_tool_call parsing failed (attempt {parse_retry+1}/3), will retry API request: {e}")
                # Remove the recently appended assistant message to avoid polluting history
                self.messages.pop()
                # Retry API request
                response = None
                for attempt in range(API_RETRY_TIMES):
                    try:
                        response = client.beta.messages.create(
                            max_tokens=actual_max_tokens,
                            messages=self.messages,
                            model=get_model_name(self.provider, self.model_name),
                            system=[system],
                            tools=tools,
                            betas=betas,
                            extra_body=extra_body,
                            **self._get_sampling_params()
                        )
                        
                        logger.info(f"Response: {response}")
                        break  # Success, exit retry loop
                    except (APIError, APIStatusError, APIResponseValidationError) as e2:
                        error_msg = str(e2)
                        logger.warning(f"Anthropic API error (attempt {attempt+1}/{API_RETRY_TIMES}): {error_msg}")
                        if attempt < API_RETRY_TIMES - 1:
                            time.sleep(API_RETRY_INTERVAL)
                        else:
                            raise
                response_params = _response_to_params(response)
                logger.info(f"Received response params: {response_params}")
                
                # Update raw response string for retry case (will be used in next loop iteration)
                raw_response_str = self._extract_raw_response_string(response)
                
                self.messages.append({
                    "role": "assistant",
                    "content": response_params
                })
                if parse_retry == max_parse_retry - 1:
                    logger.error(f"parse_actions_from_tool_call parsing failed 3 times consecutively, terminating: {e}")
                    actions = [{
                        "action_type": "FAIL",
                        "raw_response": f"Failed to parse actions from tool call after {max_parse_retry} attempts: {e}"
                    }]
                    return reasonings, actions
    def reset(self, _logger = None, *args, **kwargs):
        """
        Reset the agent's state.
        """
        global logger
        if _logger:
            logger = _logger
        else:
            logger = logging.getLogger("desktopenv.agent")
        self.messages = []
        logger.info(f"{self.class_name} reset.")

