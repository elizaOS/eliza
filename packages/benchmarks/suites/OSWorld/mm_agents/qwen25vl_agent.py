import base64
import json
import logging
import time
import os
from io import BytesIO
from typing import Dict, List, Tuple

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
    Process an image for Qwen VL models.
    Resize the image to dimensions expected by the model.
    
    Args:
        image_bytes: Raw image bytes
    
    Returns:
        Base64 encoded image string of the processed image
    """
    # Open image from bytes
    image = Image.open(BytesIO(image_bytes))
    width, height = image.size
    
    # Calculate resized dimensions
    resized_height, resized_width = smart_resize(
        height=height, 
        width=width
    )
    
    # Resize the image
    image = image.resize((resized_width, resized_height))
    
    # Convert to bytes
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    processed_bytes = buffer.getvalue()
    
    # Return base64 encoded string
    return base64.b64encode(processed_bytes).decode('utf-8')


class Qwen25VLAgent:

    def __init__(
        self,
        platform="ubuntu",
        model="qwen2.5-vl-72b-instruct",
        max_tokens=1500,
        top_p=0.9,
        temperature=0.5,
        action_space="pyautogui",
        observation_type="screenshot",
        history_n=4,  # Number of previous interactions to include in full detail
        add_thought_prefix=False,
    ):
        self.platform = platform
        self.model = model
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        self.history_n = history_n  # Control how many previous interactions to include
        self.add_thought_prefix = add_thought_prefix
        assert action_space in ["pyautogui"], "Invalid action space"
        assert observation_type in ["screenshot"], "Invalid observation type"
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.responses = []  # Store model responses
        self.screenshots = []  # Store processed screenshots

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Predict the next action(s) based on the current observation.
        """
        # Process the screenshot image
        screenshot_bytes = obs["screenshot"]
        
        # Display original dimensions
        image = Image.open(BytesIO(screenshot_bytes))
        width, height = image.size
        print(f"Original screen resolution: {width}x{height}")
        
        # Process the image
        processed_image = process_image(screenshot_bytes)
        processed_img = Image.open(BytesIO(base64.b64decode(processed_image)))
        processed_width, processed_height = processed_img.size
        print(f"Processed image resolution: {processed_width}x{processed_height}")
        
        # Save the current screenshot to history
        self.screenshots.append(processed_image)
        
        # Calculate history window start index
        current_step = len(self.actions)
        history_start_idx = max(0, current_step - self.history_n)
        
        # Build previous actions string - only include actions outside the history window
        previous_actions = []
        for i in range(history_start_idx):
            if i < len(self.actions):
                previous_actions.append(f"Step {i+1}: {self.actions[i]}")
        previous_actions_str = "\n".join(previous_actions) if previous_actions else "None"

        # System prompt with tool definition
        tools_def = {
            "type": "function", 
            "function": {
                "name_for_human": "computer_use", 
                "name": "computer_use", 
                "description": "Use a mouse and keyboard to interact with a computer, and take screenshots.",
                "parameters": {
                    "properties": {
                        "action": {
                            "description": "The action to perform.",
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
        
        system_prompt = """You are a helpful assistant

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
""" + json.dumps(tools_def) + """
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>"""

        # Create instruction prompt
        instruction_prompt = f"""
Please generate the next move according to the UI screenshot, instruction and previous actions.

Instruction: {instruction}

Previous actions:
{previous_actions_str}"""

        # Initialize messages with system prompt
        messages = [
            {
                "role": "system",
                "content": [{
                    "type": "text",
                    "text": system_prompt
                }]
            }
        ]
        
        # Add history responses and images within the history window
        history_len = min(self.history_n, len(self.responses))
        if history_len > 0:
            # Only include the most recent history_n steps
            history_responses = self.responses[-history_len:]
            history_screenshots = self.screenshots[-history_len-1:-1]  # Include one more for the previous screenshot
            
            # Add history in conversation format
            for idx in range(history_len):
                # Add the screenshot (user message)
                if idx < len(history_screenshots):
                    screenshot_b64 = history_screenshots[idx]
                    
                    # If this is the first history item, include instruction prompt
                    if idx == 0:
                        messages.append({
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:image/png;base64,{screenshot_b64}"
                                    }
                                },
                                {
                                    "type": "text",
                                    "text": instruction_prompt
                                }
                            ]
                        })
                    else:
                        messages.append({
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:image/png;base64,{screenshot_b64}"
                                    }
                                }
                            ]
                        })
                
                # Add the action and response (assistant message)
                
                messages.append({
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": history_responses[idx]}
                    ]
                })
            
            # Add the current screenshot without instruction (since we already have history)
            messages.append({
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{processed_image}"
                        }
                    }
                ]
            })
        else:
            # If no history, just add current screenshot with instruction prompt
            messages.append({
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{processed_image}"
                        }
                    },
                    {
                        "type": "text",
                        "text": instruction_prompt
                    }
                ]
            })

        # append_text = f"""Step {current_step+1}: Thought:"""
        if self.add_thought_prefix:
            append_text = f"""Thought:"""
            messages.append({"role": "assistant", "content": [{"type": "text", "text": append_text}]})

        # Call the LLM
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

        logger.info(f"Qwen25VL Output: {response}")
        
        # Save response to history
        self.responses.append(response)

        # Parse response and extract pyautogui code
        low_level_instruction, pyautogui_code = self.parse_response(
            response, 
            width, 
            height, 
            processed_width, 
            processed_height
        )

        logger.info(f"Low level instruction: {low_level_instruction}")
        logger.info(f"Pyautogui code: {pyautogui_code}")

        # Add the action to history
        self.actions.append(low_level_instruction)

        return response, pyautogui_code

    def parse_response(self, response: str, original_width: int = None, original_height: int = None, 
                       processed_width: int = None, processed_height: int = None) -> Tuple[str, List[str]]:
        """
        Parse LLM response and convert it to low level action and pyautogui code.
        
        Args:
            response: Raw response string from the model
            original_width: Width of the original screenshot
            original_height: Height of the original screenshot
            processed_width: Width of the processed image
            processed_height: Height of the processed image
            
        Returns:
            Tuple of (low_level_instruction, list of pyautogui_commands)
        """
        low_level_instruction = ""
        pyautogui_code = []
        
        if response is None or not response.strip():
            return low_level_instruction, pyautogui_code
        
        # Define function to adjust coordinates based on original and processed dimensions
        def adjust_coordinates(x: float, y: float) -> Tuple[int, int]:
            """
            Adjust coordinates from processed image dimensions to original image dimensions.
            """
            if all([original_width, original_height, processed_width, processed_height]):
                # Calculate the scale factors between original and processed images
                x_scale = original_width / processed_width
                y_scale = original_height / processed_height
                
                # Apply scaling to get coordinates in original image space
                adjusted_x = int(x * x_scale)
                adjusted_y = int(y * y_scale)
                
                return adjusted_x, adjusted_y
            else:
                # If any dimension is missing, return the original coordinates
                return int(x), int(y)
        
        # Define inner function to process tool calls
        def process_tool_call(json_str: str) -> None:
            """Process a single tool call JSON string."""
            try:
                # Parse the JSON
                tool_call = json.loads(json_str)
                if tool_call.get("name") == "computer_use":
                    # Convert computer_use actions to pyautogui commands
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
                            pyautogui_code.append(f"pyautogui.rightClick({adj_x}, {adj_y})")
                        else:
                            pyautogui_code.append("pyautogui.rightClick()")
                            
                    elif action == "middle_click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(f"pyautogui.middleClick({adj_x}, {adj_y})")
                        else:
                            pyautogui_code.append("pyautogui.middleClick()")
                            
                    elif action == "double_click":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(f"pyautogui.doubleClick({adj_x}, {adj_y})")
                        else:
                            pyautogui_code.append("pyautogui.doubleClick()")
                            
                    elif action == "type":
                        text = args.get("text", "")
                        pyautogui_code.append(f"pyautogui.typewrite('{text}')")
                        
                    elif action == "key":
                        keys = args.get("keys", [])
                        # Fix possible formatting issues in the keys parameter
                        if isinstance(keys, list):
                            # Clean up any formatting issues in the keys
                            cleaned_keys = []
                            for key in keys:
                                # Check if the key has the "keys=[" prefix or "]" suffix
                                if isinstance(key, str):
                                    # Remove "keys=[" prefix if present
                                    if key.startswith("keys=["):
                                        key = key[6:]
                                    # Remove "]" suffix if present
                                    if key.endswith("]"):
                                        key = key[:-1]
                                    # Handle case where string contains representation of list items
                                    if key.startswith("['") or key.startswith("[\""):
                                        key = key[2:] if len(key) > 2 else key
                                    if key.endswith("']") or key.endswith("\"]"):
                                        key = key[:-2] if len(key) > 2 else key
                                    # Strip any extra whitespace
                                    key = key.strip()
                                    # Add to cleaned keys
                                    cleaned_keys.append(key)
                                else:
                                    cleaned_keys.append(key)
                            keys = cleaned_keys
                            
                        # Format the keys for hotkey or press command
                        keys_str = ", ".join([f"'{key}'" for key in keys])
                        if len(keys) > 1:
                            pyautogui_code.append(f"pyautogui.hotkey({keys_str})")
                        else:
                            pyautogui_code.append(f"pyautogui.press({keys_str})")
                            
                    elif action == "scroll":
                        pixels = args.get("pixels", 0)
                        pyautogui_code.append(f"pyautogui.scroll({pixels})")
                        
                    elif action == "wait":
                        pyautogui_code.append("WAIT")  # Special code for wait action
                        
                    elif action == "terminate":
                        pyautogui_code.append("DONE")  # Special code for termination
                        
                    elif action == "mouse_move":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            pyautogui_code.append(f"pyautogui.moveTo({adj_x}, {adj_y})")
                        else:
                            pyautogui_code.append("pyautogui.moveTo(0, 0)")
                            
                    elif action == "left_click_drag":
                        if "coordinate" in args:
                            x, y = args["coordinate"]
                            adj_x, adj_y = adjust_coordinates(x, y)
                            duration = args.get("duration", 0.5)
                            pyautogui_code.append(f"pyautogui.dragTo({adj_x}, {adj_y}, duration={duration})")
                        else:
                            pyautogui_code.append("pyautogui.dragTo(0, 0)")
            except (json.JSONDecodeError, KeyError) as e:
                logger.error(f"Failed to parse tool call: {e}")
        
        # Parse the response line by line
        lines = response.split('\n')
        inside_tool_call = False
        current_tool_call = []
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            # Extract low-level instruction from lines starting with "Action:" or similar
            if line.lower().startswith(("action:", "step", "i will", "i'll", "now i")):
                if not low_level_instruction:
                    # Only store the first action description as low level instruction
                    low_level_instruction = line
                continue
            
            # Handle lines inside tool call markers
            if line.startswith("<tool_call>") or line.startswith("⚗") or line.startswith("📐"): # Yeah, it's a bug during data processing
                inside_tool_call = True
                continue
            elif line.startswith("</tool_call>") or line.startswith("⚗") or line.startswith("📐"): # Yeah, it's a bug during data processing
                if current_tool_call:
                    # Process the collected tool call
                    process_tool_call("\n".join(current_tool_call))
                    current_tool_call = []
                inside_tool_call = False
                continue
            
            if inside_tool_call:
                current_tool_call.append(line)
                continue
            
            # Try to parse individual lines as JSON
            if line.startswith("{") and line.endswith("}"):
                try:
                    json_obj = json.loads(line)
                    if "name" in json_obj and "arguments" in json_obj:
                        process_tool_call(line)
                except json.JSONDecodeError:
                    pass
        
        # Process any remaining tool call content
        if current_tool_call:
            process_tool_call("\n".join(current_tool_call))
        
        # If we still don't have a low-level instruction, generate a default one
        if not low_level_instruction and len(pyautogui_code) > 0:
            action_type = pyautogui_code[0].split(".", 1)[1].split("(", 1)[0]
            low_level_instruction = f"Performing {action_type} action"
        
        return low_level_instruction, pyautogui_code

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
        max_tries=5,
    )
    def call_llm(self, payload, model):
        messages = payload["messages"]

        base_url = os.getenv('DASHSCOPE_BASE_URL', "https://dashscope.aliyuncs.com/compatible-mode/v1")
        api_key = os.getenv('DASHSCOPE_API_KEY', "sk-123")
        
        client = openai.OpenAI(
            base_url=base_url,
            api_key=api_key
        )

        for _ in range(MAX_RETRY_TIMES):
            logger.info("Generating content with Qwen model: %s", model)
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    max_tokens=self.max_tokens,
                    temperature=self.temperature,
                    top_p=self.top_p
                )
                return response.choices[0].message.content
            except Exception as e:
                logger.error(f"Error calling Qwen model: {e}")
                time.sleep(5)
                continue
        return ""

    def reset(self, _logger=None):
        global logger
        logger = (_logger if _logger is not None else
                  logging.getLogger("desktopenv.qwen25vl_agent"))

        self.thoughts = []
        self.action_descriptions = []
        self.actions = []
        self.observations = []
        self.responses = []  # Reset responses
        self.screenshots = []  # Reset screenshots
