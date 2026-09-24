"""
Dart Agent - Custom agent for GUI automation using Dart models
Based on UITARSAgent structure but using Dart-specific utilities and prompts
"""
import ast
import base64
import logging
import math
import os
import re
import time
from io import BytesIO
from typing import Dict, List, Any
from PIL import Image
from openai import OpenAI
import backoff
import openai
import requests
from requests.exceptions import SSLError
from google.api_core.exceptions import (
    BadRequest,
    InternalServerError,
    InvalidArgument,
    ResourceExhausted,
)

# Import Dart-specific utilities and prompts
from mm_agents.dart_gui.utils import (
    pil_to_base64,
    parse_action_to_structure_output,
    parsing_response_to_pyautogui_code,
    parse_action,
    escape_single_quotes,
    round_by_factor,
    ceil_by_factor,
    floor_by_factor,
    linear_resize,
    smart_resize,
    add_box_token,
    IMAGE_FACTOR,
    MIN_PIXELS,
    MAX_PIXELS,
    MAX_RATIO,
    FINISH_WORD,
    WAIT_WORD,
    ENV_FAIL_WORD,
    CALL_USER
)

from mm_agents.dart_gui.prompts import (
    COMPUTER_USE_PROMPT,
    COMPUTER_USE_PROMPT_WITH_CALL_USER,
    UITARS_ACTION_SPACE,
    UITARS_CALL_USR_ACTION_SPACE,
    UITARS_USR_PROMPT_THOUGHT,
    UITARS_USR_PROMPT_NOTHOUGHT
)

logger = logging.getLogger("desktopenv.agent")

class DartAgent:
    def __init__(
        self,
        model: str,
        runtime_conf: Dict,
        platform="ubuntu",
        max_tokens=1000,
        top_p=0.9,
        top_k=1.0,
        temperature=0.0,
        action_space="pyautogui",
        observation_type="screenshot",
        max_trajectory_length=50,
        model_type="qwen25vl",
        **kwargs
    ):
        self.model = model
        self.platform = platform
        self.action_space = action_space
        self.observation_type = observation_type
        self.max_trajectory_length = max_trajectory_length
        self.model_type = model_type
        self.runtime_conf = runtime_conf
        
        # Extract runtime configuration parameters
        self.max_tokens = self.runtime_conf.get("max_tokens", max_tokens)
        self.top_p = self.runtime_conf.get("top_p", top_p)
        self.top_k = self.runtime_conf.get("top_k", top_k)
        self.temperature = self.runtime_conf.get("temperature", temperature)
        self.infer_mode = self.runtime_conf.get("infer_mode", "dart_mode")
        self.prompt_style = self.runtime_conf.get("prompt_style", "dart_style")
        self.input_swap = self.runtime_conf.get("input_swap", False)
        self.language = self.runtime_conf.get("language", "English")
        self.max_pixels = self.runtime_conf.get("max_pixels", MAX_PIXELS)
        self.min_pixels = self.runtime_conf.get("min_pixels", MIN_PIXELS)
        self.history_n = self.runtime_conf.get("history_n", 5)
        
        # Dart specific configurations
        self.max_images = self.runtime_conf.get("max_images", 5)
        self.max_texts = self.runtime_conf.get("max_texts", 35)
        
        # Initialize OpenAI client - use Dart API if provided
        dart_api_key = self.runtime_conf.get("dart_api_key", "")
        dart_base_url = self.runtime_conf.get("dart_base_url", "")
        
        if dart_base_url:
            # 检查是否为直接的生成端点（包含 /generate）
            if '/generate' in dart_base_url:
                # 直接使用提供的 URL，不添加 /v1
                logger.info(f"使用直接生成端点: {dart_base_url}")
                self.dart_direct_url = dart_base_url
                self.vlm = None  # 不使用 OpenAI 客户端
            else:
                # 传统的 OpenAI 兼容端点，确保以 /v1 结尾
                if not dart_base_url.endswith('/v1'):
                    dart_base_url = dart_base_url.rstrip('/') + '/v1'
                
                self.vlm = OpenAI(
                    base_url=dart_base_url,
                    api_key=dart_api_key,
                )
                self.dart_direct_url = None
        else:
            # Fallback to environment variables
            base_url = os.environ.get('DART_API_URL', os.environ.get('DOUBAO_API_URL'))
            if base_url:
                if '/generate' in base_url:
                    # 直接生成端点
                    self.dart_direct_url = base_url
                    self.vlm = None
                else:
                    if not base_url.endswith('/v1'):
                        base_url = base_url.rstrip('/') + '/v1'
                    self.vlm = OpenAI(
                        base_url=base_url,
                        api_key=os.environ.get('DART_API_KEY', os.environ.get('DOUBAO_API_KEY')),
                    )
                    self.dart_direct_url = None
            else:
                self.vlm = None
                self.dart_direct_url = None

        # Initialize trajectory storage - similar to trajectory_runner.py
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.history_images = []
        self.history_responses = []
        
        # Message handling similar to trajectory_runner.py
        self.base_messages = []          # for model client (with base64 images)
        self.base_messages_for_save = [] # for storage (with file paths)
        self.prompt_dialogue = []        # for model client
        self.save_dialogue = []          # for storage
        self.save_dialogue_full = []     # for full storage (保存所有图片路径)
        self.image_refs = []             # record image position
        
        # All image paths storage - to keep track of all images even when trimmed
        self.all_image_paths = []
        
        # Current screenshot file path for proper saving
        self.current_screenshot_path = None
        
        # Configure prompt and action space based on mode
        if self.infer_mode == "dart_mode":           
            self.prompt_action_space = UITARS_ACTION_SPACE
            self.prompt_template = COMPUTER_USE_PROMPT
        else:
            # For qwen2vl_user mode
            self.prompt_action_space = UITARS_CALL_USR_ACTION_SPACE
            if self.prompt_style == "qwen2vl_user":
                self.prompt_template = UITARS_USR_PROMPT_THOUGHT
            elif self.prompt_style == "qwen2vl_no_thought":
                self.prompt_template = UITARS_USR_PROMPT_NOTHOUGHT
            else:
                self.prompt_template = UITARS_USR_PROMPT_THOUGHT
       
        self.action_parse_res_factor = 1000
        
        logger.info(f"Initialized DartAgent with model: {self.model}, mode: {self.infer_mode}")

    def reset(self, runtime_logger=None):
        """Reset the agent state"""
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.history_images = []
        self.history_responses = []
        
        # Reset message handling
        self.base_messages = []
        self.base_messages_for_save = []
        self.prompt_dialogue = []
        self.save_dialogue = []
        self.save_dialogue_full = []
        self.image_refs = []
        self.all_image_paths = []
        self.current_screenshot_path = None
        
        logger.info("DartAgent reset")

    def set_base_messages(self, instruction: str):
        """Initialize base messages similar to task_loader.py"""
        system_prompt = COMPUTER_USE_PROMPT
            
        self.base_messages = [
            {
                "role": "system",
                "content": "You are a helpful assistant."
            },
            {
                "role": "user", 
                "content": [
                    {
                        "type": "text",
                        "text": system_prompt.format(
                            instruction=instruction,
                            language=self.language
                        )
                    }
                ]
            }
        ]
        
        # Copy for save version
        from copy import deepcopy
        self.base_messages_for_save = deepcopy(self.base_messages)

    def set_current_screenshot_path(self, screenshot_path: str):
        """Set the current screenshot file path for proper saving"""
        self.current_screenshot_path = screenshot_path

    def predict(
        self, instruction: str, obs: Dict, last_action_after_obs: Dict = None
    ) -> tuple:
        """
        Predict the next action(s) based on the current observation.
        Returns: (response_text, actions_list)
        """
        # Initialize base messages if not set
        if not self.base_messages:
            self.set_base_messages(instruction)
        
        # Store current observation
        self._add_observation(obs)
        
        # For first step, set the first frame
        if len(self.observations) == 1:
            self._set_first_frame(obs["screenshot"], self.current_screenshot_path)
        else:
            # For subsequent steps, add the new image to dialogue
            # This represents the result of the previous action
            self._add_image(obs["screenshot"], self.current_screenshot_path)
        
        # Build prompt messages (base_messages + prompt_dialogue)
        messages = self._build_messages()
        
        # Call model to get response
        prediction = self._call_model(messages)
        if prediction is None:
            return "client error", ["DONE"]
        
        # Store response and parse actions
        self._add_text(prediction)
        
        # Parse response to actions
        try:
            image_size = self._get_current_image_size()
            actions = self._parse_and_convert_actions(prediction, image_size)
            
            # Check for terminal actions
            terminal_action = self._check_terminal_actions(actions)
            if terminal_action:
                self.actions.append(actions)
                return prediction, [terminal_action]
                
        except Exception as e:
            logger.error(f"Parsing action error: {prediction}, error: {e}")
            return f"Parsing action error: {prediction}, error: {e}", ["DONE"]
        
        self.actions.append(actions)        
        # Check max steps
        if len(self.history_responses) >= self.max_trajectory_length:
            actions = ["FAIL"]
            
        return prediction, actions

    @backoff.on_exception(
        backoff.constant,
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
        ),
        interval=30,
        max_tries=10,
    )
    def predict_with_backoff(self, instruction: str, obs: Dict, last_action_after_obs: Dict = None):
        """Predict with backoff for rate limiting and temporary errors"""
        return self.predict(instruction, obs, last_action_after_obs)

    def get_trajectory(self) -> List[Dict]:
        """Get the current trajectory for saving"""
        trajectory = []
        for i in range(len(self.observations)):
            trajectory.append({
                "observation": self.observations[i],
                "thought": self.thoughts[i] if i < len(self.thoughts) else "",
                "action": self.actions[i] if i < len(self.actions) else []
            })
        return trajectory
    
    def get_full_messages(self) -> List[Dict]:
        """Get the complete conversation messages for saving (including base messages and dialogue)"""
        # Combine base_messages_for_save with save_dialogue_full to get complete conversation
        full_messages = []
        
        # Add base messages (system prompt and initial user message)
        full_messages.extend(self.base_messages_for_save)
        
        # Add dialogue messages (user images + assistant responses) with all images
        full_messages.extend(self.save_dialogue_full)
        
        return full_messages
    
    def get_all_image_paths(self) -> List[str]:
        """Get all image paths that have been used throughout the conversation"""
        return self.all_image_paths.copy()

    # ========== Private Methods ==========
    
    def _validate_trajectory(self):
        """Validate trajectory consistency"""
        assert len(self.observations) == len(self.actions) and len(self.actions) == len(
            self.thoughts
        ), "The number of observations and actions should be the same."

    def _add_observation(self, obs: Dict):
        """Process observation and add to history"""
        # Store observation
        if self.observation_type in ["screenshot", "screenshot_a11y_tree"]:
            base64_image = obs["screenshot"]
            try:
                # Handle accessibility tree if needed
                linearized_accessibility_tree = None
                if self.observation_type == "screenshot_a11y_tree" and "accessibility_tree" in obs:
                    # For now, we'll skip accessibility tree processing in Dart mode
                    linearized_accessibility_tree = None
            except:
                linearized_accessibility_tree = None

            if self.observation_type == "screenshot_a11y_tree":
                self.observations.append({
                    "screenshot": base64_image,
                    "accessibility_tree": linearized_accessibility_tree,
                })
            else:
                self.observations.append({
                    "screenshot": base64_image, 
                    "accessibility_tree": None
                })
        else:
            raise ValueError("Invalid observation_type type: " + self.observation_type)


    def _build_messages(self) -> List[Dict]:
        """Build messages for model API call - similar to trajectory_runner._build_messages"""
        return self.base_messages + self.prompt_dialogue

    def _call_model(self, messages: List[Dict]) -> str:
        """Call model with retry logic"""
        try_times = 3
        while try_times > 0:
            try:
                # 如果使用直接生成端点
                if hasattr(self, 'dart_direct_url') and self.dart_direct_url:
                    prediction = self._call_direct_generate_endpoint(messages)
                else:
                    # 使用标准 OpenAI 客户端
                    response = self.vlm.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        frequency_penalty=1,
                        max_tokens=self.max_tokens,
                        temperature=self.temperature,
                        top_p=self.top_p
                    )
                    prediction = response.choices[0].message.content
                
                logger.info(f"Model response: {prediction}")
                return prediction
                
            except Exception as e:
                logger.error(f"Error when fetching response from client: {e}")
                try_times -= 1
                if try_times <= 0:
                    logger.error("Reach max retry times to fetch response from client")
                    return None
        return None

    def _call_direct_generate_endpoint(self, messages: List[Dict]) -> str:
        """直接调用生成端点"""
        try:
   
            
            # 构建请求数据
            payload = {
                "messages": messages,
                "model": self.model,
                "max_tokens": self.max_tokens,
                "temperature": self.temperature,
                "top_p": self.top_p,
                "frequency_penalty": 1
            }
            
            # 添加 API key 到 headers
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.runtime_conf.get('dart_api_key', '')}"
            }
            
          
            # 重试机制：最多重试3次，每次推理60秒
            max_retries = 3
            response = None
            
            for attempt in range(max_retries):
                try:
                    logger.info(f"尝试第 {attempt + 1} 次请求...")
                    response = requests.post(
                        self.dart_direct_url,
                        json=payload,
                        headers=headers,
                        timeout=60
                    )
                    response.raise_for_status()
                    break  # 成功则跳出重试循环
                except Exception as e:
                    logger.warning(f"第 {attempt + 1} 次请求失败: {e}")
                    if attempt == max_retries - 1:  # 最后一次重试失败
                        logger.error(f"所有 {max_retries} 次重试都失败了")
                        raise e
                    else:
                        logger.info(f"等待后重试...")
                        import time
                        time.sleep(2)  # 等待2秒后重试
            
            # 解析响应
            result = response.json()
            
            # 尝试多种可能的响应格式
            if 'choices' in result and len(result['choices']) > 0:
                # OpenAI 兼容格式
                return result['choices'][0]['message']['content']
            elif 'response' in result:
                # 简单的 response 字段
                return result['response']
            elif 'text' in result:
                # text 字段
                return result['text']
            elif 'content' in result:
                # content 字段
                return result['content']
            else:
                # 如果找不到标准字段，返回整个响应的字符串
                logger.warning(f"未知的响应格式: {result}")
                return str(result)
                
        except Exception as e:
            logger.error(f"直接端点调用失败: {e}")
            raise e

    def _add_text(self, assistant_txt: str):
        """Add text response to history - similar to trajectory_runner.py"""
        self.history_responses.append(assistant_txt)
        self.thoughts.append(assistant_txt)
        
        # Add to dialogue similar to trajectory_runner._add_text
        msg = {
            "role": "assistant",
            "content": add_box_token(assistant_txt)
        }
        self.prompt_dialogue.append(msg)
        self.save_dialogue.append(msg)
        self.save_dialogue_full.append(msg)
        self._trim()

    def _set_first_frame(self, obs_img: bytes, frame_path: str = None):
        """Set first frame in base_messages - similar to trajectory_runner._set_first_frame"""
        self.base_messages[1]["content"].append(
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64," + pil_to_base64(obs_img)}
            }
        )
        
        # Use actual frame path if provided, otherwise use current_screenshot_path or placeholder
        if frame_path:
            first_frame_path = frame_path
        elif self.current_screenshot_path:
            first_frame_path = self.current_screenshot_path
        else:
            first_frame_path = "first_frame.png"
            
        # Store in all_image_paths
        self.all_image_paths.append(first_frame_path)
        
        self.base_messages_for_save[1]["content"].append(
            {
                "type": "image_url", 
                "image_url": first_frame_path
            }
        )
        
        self.image_refs.append(
            {"source": "base", "msg_idx": 1,
            "content_idx": len(self.base_messages[1]["content"]) - 1}
        )

    def _add_image(self, img_bytes: bytes, frame_path: str = None):
        """Add image to dialogue - similar to trajectory_runner._add_image"""
        self.prompt_dialogue.append({
            "role": "user",
            "content": [{
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64," + pil_to_base64(img_bytes)}
            }]
        })

        # Use actual frame path if provided, otherwise use current_screenshot_path
        if frame_path:
            image_url = frame_path
        elif self.current_screenshot_path:
            image_url = self.current_screenshot_path
        else:
            # Fallback to a placeholder - this should rarely happen in practice
            image_url = f"frame_{len(self.save_dialogue)}.png"
            
        # Store in all_image_paths for complete record
        self.all_image_paths.append(image_url)

        # Add to save_dialogue (trimmed version)
        self.save_dialogue.append({
            "role": "user", 
            "content": [{
                "type": "image_url",
                "image_url": image_url
            }]
        })
        
        # Add to save_dialogue_full (complete version - never trimmed)
        self.save_dialogue_full.append({
            "role": "user", 
            "content": [{
                "type": "image_url",
                "image_url": image_url
            }]
        })
        
        self.image_refs.append(
            {"source": "dialogue", "msg_idx": len(self.prompt_dialogue) - 1,
            "content_idx": None}
        )
        
        self._trim()

    def _trim(self):
        """Ensure image num ≤ max_images and assistant text num ≤ max_texts - similar to trajectory_runner._trim"""
        img_cnt = len(self.image_refs)
        txt_cnt = sum(m["role"] == "assistant" for m in self.prompt_dialogue)

        while img_cnt > self.max_images or txt_cnt > self.max_texts:
            # 图片超限：最早一张
            if img_cnt > self.max_images:
                ref = self.image_refs.pop(0)
                if ref["source"] == "base":
                    self.base_messages[ref["msg_idx"]]["content"].pop(ref["content_idx"])
                else:  # dialogue 图
                    self._remove_dialogue_msg(ref["msg_idx"])
                img_cnt -= 1
                continue

            # 文本超限：最早 assistant 文本
            if txt_cnt > self.max_texts:
                for i, m in enumerate(self.prompt_dialogue):
                    if m["role"] == "assistant":
                        self._remove_dialogue_msg(i)
                        txt_cnt -= 1
                        break

    def _remove_dialogue_msg(self, idx: int):
        """Remove dialogue message and update refs - similar to trajectory_runner._remove_dialogue_msg"""
        self.prompt_dialogue.pop(idx)
        self.save_dialogue.pop(idx)
        # Note: save_dialogue_full is never trimmed, so we don't remove from it

        # 更新 image_refs
        self.image_refs = [
            r if not (r["source"] == "dialogue" and r["msg_idx"] == idx)
            else None  # 同一条被删掉的图引用直接丢弃
            for r in self.image_refs
        ]
        self.image_refs = [
            (
                {**r, "msg_idx": r["msg_idx"] - 1}
                if r and r["source"] == "dialogue" and r["msg_idx"] > idx  # idx后的图片索引均-1
                else r
            )
            for r in self.image_refs
            if r  # 剔除 None
        ]

    def _get_current_image_size(self) -> tuple:
        """Get current image size for coordinate conversion"""
        if len(self.observations) > 0:
            try:
                current_image_bytes = self.observations[-1]["screenshot"]
                if isinstance(current_image_bytes, bytes):
                    current_image = Image.open(BytesIO(current_image_bytes))
                    return (current_image.height, current_image.width)
            except Exception as e:
                logger.warning(f"Error getting image size: {e}")
        
        # Fallback to default screen size
        return (1080, 1920)

    def _parse_and_convert_actions(self, prediction: str, image_size: tuple) -> List[str]:
        """Parse response and convert to pyautogui actions - similar to trajectory_runner._parse"""
        image_height, image_width = image_size
        
        # Parse the response to structured actions
        parsed_responses = parse_action_to_structure_output(
            prediction,
            factor=self.action_parse_res_factor,
            origin_resized_height=image_height,
            origin_resized_width=image_width,
            model_type=self.model_type,
            max_pixels=self.max_pixels,
            min_pixels=self.min_pixels
        )
        
        # Convert parsed responses to pyautogui actions
        actions = []
        for parsed_response in parsed_responses:
            try:
                pyautogui_code = parsing_response_to_pyautogui_code(
                    parsed_response,
                    image_height=image_height,
                    image_width=image_width,
                    input_swap=self.input_swap
                )
                
               
                
                actions.append(pyautogui_code)
                
            except Exception as e:
                logger.error(f"Error generating pyautogui code: {e}")
                actions.append("FAIL")
        
        return actions

    

    def _check_terminal_actions(self, actions: List[str]) -> str:
        """Check if any action is terminal and return appropriate code"""
        for action in actions:
            if isinstance(action, dict) and "action_type" in action:
                action_type = action["action_type"]
                if action_type == FINISH_WORD:
                    return "DONE"
                elif action_type == WAIT_WORD:
                    return "WAIT"
                elif action_type == ENV_FAIL_WORD:
                    return "FAIL"
                elif action_type == CALL_USER:
                    return "FAIL"
        return None
