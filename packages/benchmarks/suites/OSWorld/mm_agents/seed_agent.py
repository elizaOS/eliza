
import os
import re
import base64
import requests
import logging
from typing import Optional, Dict, List, Tuple, Union
from loguru import logger
from ui_tars.action_parser import parse_xml_action, parsing_response_to_pyautogui_code, parse_xml_action_v3
import ast
import base64
import json
import math
import io
import re
from PIL import Image
from volcenginesdkarkruntime import Ark

FINISH_WORD = "finished"
WAIT_WORD = "wait"
ENV_FAIL_WORD = "error_env"
CALL_USER = "call_user"
INFEASIBLE = "infeasible"

GUI_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "click",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Click coordinates. The format is: <point>x y</point>"
                    }
                },
                "required": [
                    "point"
                ]
            },
            "description": "Mouse left single click action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "left_double",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Click coordinates. The format is: <point>x y</point>"
                    }
                },
                "required": [
                    "point"
                ]
            },
            "description": "Mouse left double click action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "right_single",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Click coordinates. The format is: <point>x y</point>"
                    }
                },
                "required": [
                    "point"
                ]
            },
            "description": "Mouse right single click action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "drag",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_point": {
                        "type": "string",
                        "description": "Drag start point. The format is: <point>x y</point>"
                    },
                    "end_point": {
                        "type": "string",
                        "description": "Drag end point. The format is: <point>x y</point>"
                    }
                },
                "required": [
                    "start_point",
                    "end_point"
                ]
            },
            "description": "Mouse left button drag action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "scroll",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Scroll start position. If not specified, default to execute on the current mouse position. The format is: <point>x y</point>"
                    },
                    "direction": {
                        "type": "string",
                        "description": "Scroll direction.",
                        "enum": [
                            "up",
                            "down",
                            "left",
                            "right"
                        ]
                    }
                },
                "required": [
                    "direction"
                ]
            },
            "description": "Scroll action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "move_to",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Target coordinates. The format is: <point>x y</point>"
                    }
                },
                "required": [
                    "point"
                ]
            },
            "description": "Mouse move action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_down",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Mouse down position. If not specified, default to execute on the current mouse position. The format is: <point>x y</point>"
                    },
                    "button": {
                        "type": "string",
                        "description": "Down button. Default to left.",
                        "enum": [
                            "left",
                            "right"
                        ]
                    }
                },
                "required": []
            },
            "description": "Mouse down action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_up",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": {
                        "type": "string",
                        "description": "Mouse up position. If not specified, default to execute on the current mouse position. The format is: <point>x y</point>"
                    },
                    "button": {
                        "type": "string",
                        "description": "Up button. Default to left.",
                        "enum": [
                            "left",
                            "right"
                        ]
                    }
                },
                "required": []
            },
            "description": "Mouse up action."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "type",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "Type content. If you want to submit your input, use \n at the end of content."
                    }
                },
                "required": [
                    "content"
                ]
            },
            "description": "Type content."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "hotkey",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Hotkeys you want to press. Split keys with a space and use lowercase."
                    }
                },
                "required": [
                    "key"
                ]
            },
            "description": "Press hotkey."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "press",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key you want to press. Only one key can be pressed at one time."
                    }
                },
                "required": [
                    "key"
                ]
            },
            "description": "Press key."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "release",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key you want to release. Only one key can be released at one time."
                    }
                },
                "required": [
                    "key"
                ]
            },
            "description": "Release key."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "finished",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "Provide the final answer or response to complete the task."
                    }
                },
                "required": []
            },
            "description": "This function is used to indicate the completion of a task by providing the final answer or response."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "call_user",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "Message or information displayed to the user to request their input, feedback, or guidance."
                    }
                },
                "required": []
            },
            "description": "This function is used to interact with the user by displaying a message and requesting their input, feedback, or guidance."
        }
    },
    {
        "type": "function",
        "function": {
            "name": "wait",
            "parameters": {
                "type": "object",
                "properties": {
                    "time": {
                        "type": "integer",
                        "description": "Wait time in seconds."
                    }
                },
                "required": []
            },
            "description": "Wait for a while."
        }
    },
    {
        "type": "function",
        "function": {
          "name": "infeasible",
          "parameters": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "description": "Message or information displayed to the user to explain why the current task is infeasible."
              }
            },
            "required": ["content"]
          },
          "description": "This function is used to indicate that the current task is infeasible thus agent ends the task."
        }
    }
]

def modify_conversations(conversations):
    new_conversations = []
    for conversation in conversations:
        if isinstance(conversation["content"], list):
            if "type" in conversation["content"][0] and conversation["content"][0]["type"] == "image_url":
                conversation["content"][0]["image_url"]["detail"] = "high"
        new_conversations.append(conversation)
    return new_conversations

class SeedAgent:
    """
    UI-TARS Agent based on Seed1.5-VL model implementation.
    Integrates the GUI folder UI-TARS-1.5 implementation with the mm_agents architecture.
    """
    
    def __init__(
        self,
        # Model settings
        model: str,
        model_type: str,
        # Generation settings
        max_tokens: int,
        top_p: Optional[float],
        temperature: float,
        
        # History settings
        max_trajectory_length: Optional[int],
        history_n: Optional[int],
        
        # Outside infos
        max_steps: int = 100,
        
        # UI-TARS specific settings
        use_thinking: bool = True,
        resize_image: bool = False,
        resized_image_width: int = 1920,
        resized_image_height: int = 1080,
    ):
        """
        Initialize Seed16 Agent.
        
        Args:
            model: Model name, defaults to doubao-1-5-thinking-vision-pro-250428
            api_key: API key for the model service
            base_url: Base URL for the API service
            max_tokens: Maximum tokens to generate
            top_p: Top-p sampling parameter
            temperature: Temperature for sampling
            max_trajectory_length: Maximum trajectory history length
            screenshot_pyautogui_prompt: Prompt version
            max_steps: Maximum steps for the agent
            use_thinking: Whether to use thinking mode
            openai_client: OpenAI client instance
        """

        self.model = model
        self.max_trajectory_length = max_trajectory_length
        self.logger = logger
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.history_images = []
        self.history_responses = []
        
        self.system_prompt = "You are provided with a task description, a history of previous actions, and corresponding screenshots. Your goal is to perform the next action to complete the task. Please note that if performing the same action multiple times results in a static screen with no changes, you should attempt a modified or alternative action."
        
        self.action_parse_res_factor = 1000
        self.model_type = model_type
        self.history_n = history_n
        self.top_p = top_p
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.platform = "ubuntu"
        self.use_thinking = use_thinking

        self.inference_func = self.inference_with_thinking_ark
        self.resize_image = resize_image
        self.resized_image_width = resized_image_width
        self.resized_image_height = resized_image_height
        self.input_swap = False
    
    def reset(self, _logger=None, vm_ip=None, **kwargs):
        global logger
        logger = _logger if _logger is not None else logging.getLogger("desktopenv.agent")

        self.vm_ip = vm_ip

        self.thoughts = []
        self.actions = []
        self.observations = []
        self.history_images = []
        self.history_responses = []

    def pretty_print_messages(self, messages):
        """Pretty print messages while hiding base64 encoded images."""
        def format_message(msg):
            if not isinstance(msg, dict):
                return str(msg)
            
            formatted = {}
            for key, value in msg.items():
                if key == "content":
                    if isinstance(value, list):
                        formatted_content = []
                        for item in value:
                            if isinstance(item, dict) and "type" in item:
                                if item["type"] == "image_url" and "image_url" in item:
                                    # Replace base64 image with placeholder
                                    formatted_content.append({
                                        "type": "image_url",
                                        "image_url": {"url": "[BASE64_IMAGE_DATA]"}
                                    })
                                else:
                                    formatted_content.append(item)
                            else:
                                formatted_content.append(item)
                        formatted[key] = formatted_content
                    else:
                        formatted[key] = value
                else:
                    formatted[key] = value
            return formatted

        if isinstance(messages, list):
            return [format_message(msg) for msg in messages]
        return format_message(messages)


    def inference_with_thinking(self, messages):
        api_key = os.environ['DOUBAO_API_KEY']
        api_url = os.environ['DOUBAO_API_URL']
        headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
        data = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "top_p": self.top_p,
            "temperature": self.temperature,
            "reasoning_effort": "high"
        }
        
        response = requests.post(api_url, headers=headers, json=data)
        if response.status_code == 200:
            return response.json()["choices"][0]["message"]
        else:
            return {
                "error": f"Request failed with status code {response.status_code}",
                "details": response.text
            }
    
    def inference_with_thinking_ark(self, openai_messages):
        # 打印 Ark 的 URL 和 API Key
        api_key = os.environ['DOUBAO_API_KEY']
        api_url = os.environ['DOUBAO_API_URL']
        
        # 初始化 Ark 实例
        vlm = Ark(
            base_url=api_url,
            api_key=api_key
        )
        
        
        # 调用 Ark 的 chat.completions.create 方法
        completion = vlm.chat.completions.create(
            model=self.model,
            stream=True,
            reasoning_effort='high',
            messages=openai_messages,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            top_p=self.top_p
        )
        
        # 初始化预测结果
        think_token = "think_never_used_51bce0c785ca2f68081bfa7d91973934"
        added_think_token = False
        
        # 处理流式返回的结果
        prediction = ''
        reasoning_content = ''
        content = ''
        for chunk in completion:
            if hasattr(chunk, 'choices') and chunk.choices:
                delta = chunk.choices[0].delta
                if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                    reasoning_content += delta.reasoning_content
                if hasattr(delta, 'content') and delta.content:
                    if not added_think_token:
                        prediction += f"</{think_token}>"
                        added_think_token = True
                    content += delta.content
        
        prediction = f"<{think_token}>" + reasoning_content + f"</{think_token}>" + content
        
        # 返回预测结果
        return prediction

    def inference_without_thinking(self, messages):
        api_key = os.environ['DOUBAO_API_KEY']
        api_url = os.environ['DOUBAO_API_URL']
        headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
        data = {
            "model": self.model,
            "messages": messages,
            "thinking": {"type": "disabled"},
            "max_tokens": self.max_tokens,
            "top_p": self.top_p,
            "temperature": self.temperature,
        }
        
        response = requests.post(api_url, headers=headers, json=data)
        
        
        if response.status_code == 200:
            return response.json()["choices"][0]["message"]["content"]
        else:
            print(f"Request failed with status code {response.status_code}")
            print(response.json())
            return {
                "error": f"Request failed with status code {response.status_code}",
                "details": response.text
            }

    def predict(self, task_instruction: str, obs: dict) -> Tuple[Union[str, Dict, None], List]:
        """Predict the next action based on the current observation."""
        
        self.task_instruction = task_instruction + f"\nThe sudo password is osworld-public-evaluation"
        
        assert len(self.observations) == len(self.actions) and len(self.actions) == len(
            self.thoughts
        ), "The number of observations and actions should be the same."

        # Convert binary screenshot to base64 if needed
        screenshot = obs["screenshot"]
        if isinstance(screenshot, bytes):
            screenshot = base64.b64encode(screenshot).decode('utf-8')
        
        # 获取宽度和高度
        image = Image.open(io.BytesIO(obs["screenshot"]))
        width, height = image.size
        if self.resize_image:
            resized_image = image.resize(
                (
                    self.resized_image_width,
                    self.resized_image_height,
                )
            )
            image_bytes_io = io.BytesIO()  # 创建一个 BytesIO 对象
            resized_image.save(image_bytes_io, format="PNG")  # 将图像保存到 BytesIO 中，指定格式（如 PNG）
            image_bytes = image_bytes_io.getvalue()  # 获取字节数据
            screenshot = base64.b64encode(image_bytes).decode('utf-8')
            
        self.history_images.append(screenshot)
        
        self.observations.append(
            {"screenshot": screenshot, "accessibility_tree": None}
        )
        
        if len(self.history_images) > self.history_n:
            self.history_images = self.history_images[-self.history_n:]
        
        images = self.history_images
        
        messages = [
            {
                "role": "system",
                "content": self.system_prompt
            },
            {
                "role": "system",
                "content": '''## Function Definition\n\n- You have access to the following functions:\n{"type": "function", "name": "call_user", "parameters": {"type": "object", "properties": {"content": {"type": "string", "description": "Message or information displayed to the user to request their input, feedback, or guidance."}}, "required": []}, "description": "This function is used to interact with the user by displaying a message and requesting their input, feedback, or guidance."}\n{"type": "function", "name": "click", "parameters": {"type": "object", "properties": {"point": {"type": "string", "description": "Click coordinates. The format is: <point>x y</point>"}}, "required": ["point"]}, "description": "Mouse left single click action."}\n{"type": "function", "name": "drag", "parameters": {"type": "object", "properties": {"start_point": {"type": "string", "description": "Drag start point. The format is: <point>x y</point>"}, "end_point": {"type": "string", "description": "Drag end point. The format is: <point>x y</point>"}}, "required": ["start_point", "end_point"]}, "description": "Mouse left button drag action."}\n{"type": "function", "name": "finished", "parameters": {"type": "object", "properties": {"content": {"type": "string", "description": "Provide the final answer or response to complete the task."}}, "required": []}, "description": "This function is used to indicate the completion of a task by providing the final answer or response."}\n{"type": "function", "name": "hotkey", "parameters": {"type": "object", "properties": {"key": {"type": "string", "description": "Hotkeys you want to press. Split keys with a space and use lowercase."}}, "required": ["key"]}, "description": "Press hotkey."}\n{"type": "function", "function": {"name": "infeasible", "parameters": {"type": "object", "properties": {"content": {"type": "string", "description": "Message or information displayed to the user to explain why the current task is infeasible."}}, "required": ["content"]}, "description": "This function is used to indicate that the current task is infeasible thus agent ends the task."}\n{"type": "function", "name": "left_double", "parameters": {"type": "object", "properties": {"point": {"type": "string", "description": "Click coordinates. The format is: <point>x y</point>"}}, "required": ["point"]}, "description": "Mouse left double click action."}\n{"type": "function", "name": "right_single", "parameters": {"type": "object", "properties": {"point": {"type": "string", "description": "Click coordinates. The format is: <point>x y</point>"}}, "required": ["point"]}, "description": "Mouse right single click action."}\n{"type": "function", "name": "scroll", "parameters": {"type": "object", "properties": {"point": {"type": "string", "description": "Scroll start position. If not specified, default to execute on the current mouse position. The format is: <point>x y</point>"}, "direction": {"type": "string", "description": "Scroll direction.", "enum": ["up", "down", "left", "right"]}}, "required": ["direction", "point"]}, "description": "Scroll action."}\n{"type": "function", "name": "type", "parameters": {"type": "object", "properties": {"content": {"type": "string", "description": "Type content. If you want to submit your input, use \\n at the end of content."}}, "required": ["content"]}, "description": "Type content."}\n{"type": "function", "name": "wait", "parameters": {"type": "object", "properties": {"time": {"type": "integer", "description": "Wait time in seconds."}}, "required": []}, "description": "Wait for a while."}\n\n- To call a function, use the following structure without any suffix:\n\n<think_never_used_51bce0c785ca2f68081bfa7d91973934> reasoning process </think_never_used_51bce0c785ca2f68081bfa7d91973934>\n<seed:tool_call_never_used_51bce0c785ca2f68081bfa7d91973934><function_never_used_51bce0c785ca2f68081bfa7d91973934=example_function_name><parameter_never_used_51bce0c785ca2f68081bfa7d91973934=example_parameter_1>value_1</parameter_never_used_51bce0c785ca2f68081bfa7d91973934><parameter_never_used_51bce0c785ca2f68081bfa7d91973934=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter_never_used_51bce0c785ca2f68081bfa7d91973934></function_never_used_51bce0c785ca2f68081bfa7d91973934></seed:tool_call_never_used_51bce0c785ca2f68081bfa7d91973934>\n\n## Important Notes\n- Function calls must begin with <function_never_used_51bce0c785ca2f68081bfa7d91973934= and end with </function_never_used_51bce0c785ca2f68081bfa7d91973934>.\n- All required parameters must be explicitly provided.\n\n## Additional Notes\n- You can execute multiple actions within a single tool call. For example:\n<seed:tool_call_never_used_51bce0c785ca2f68081bfa7d91973934><function_never_used_51bce0c785ca2f68081bfa7d91973934=example_function_1><parameter_never_used_51bce0c785ca2f68081bfa7d91973934=example_parameter_1>value_1</parameter_never_used_51bce0c785ca2f68081bfa7d91973934><parameter_never_used_51bce0c785ca2f68081bfa7d91973934=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter_never_used_51bce0c785ca2f68081bfa7d91973934></function_never_used_51bce0c785ca2f68081bfa7d91973934><function_never_used_51bce0c785ca2f68081bfa7d91973934=example_function_2><parameter_never_used_51bce0c785ca2f68081bfa7d91973934=example_parameter_3>value_4</parameter_never_used_51bce0c785ca2f68081bfa7d91973934></function_never_used_51bce0c785ca2f68081bfa7d91973934></seed:tool_call_never_used_51bce0c785ca2f68081bfa7d91973934>\n- 当你判断任务请求是无法执行的时候，你应该调用Infeasible工具结束任务并解释原因。\n            判断标准：当一个请求符合以下任何一条标准时，应被归类为“无法执行”。\n            1. 技术/物理层面的矛盾： 指令本身包含逻辑上或物理上无法实现的要求。\n            2. 工具/功能错配： 指令要求在一个软件中执行另一个软件的功能，或者执行该软件根本不具备的功能。\n            3. 超出操作边界/范围： 指令要求执行的操作超出了当前用户会话、权限或应用程序的逻辑边界，涉及未告知的隐私信息或者未授权的操作。\n            4. 依赖隐性知识或外部条件： 任务的完成依赖于Agent无法获取的外部硬件、物理环境、未声明的插件/扩展、或特定的文件/数据。\n\n            输出指令：\n            如果请求被判断为“无法执行”，你应该向用户解释为什么这个任务超出了你的能力范围（例如，指出它需要直接操作某个硬件），并尽可能提供一个指导性的替代方案，让用户可以自己完成该任务。\n            你应该非常非常谨慎地使用Infeasible工具，因为它会直接结束任务并降低用户体验。所以非必要的时候，你不应该调用Infeasible工具，尽量以finish工具结束任务并向用户提示原因就好。'''
            },
            {
                "role": "user",
                "content": self.task_instruction
            }
        ]
        
        image_num = 0
        if len(self.history_responses) > 0:
            for history_idx, history_response in enumerate(self.history_responses):
                # send at most history_n images to the model
                if history_idx + self.history_n > len(self.history_responses):
                    messages.append({
                        "role": "tool",
                        "content": [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{images[image_num]}"}}],
                        "tool_call_id": "1"
                    })
                    image_num += 1
                    
                messages.append({
                    "role": "assistant",
                    "content": history_response.split("</think_never_used_51bce0c785ca2f68081bfa7d91973934>")[-1],
                    "reasoning_content": history_response.split("</think_never_used_51bce0c785ca2f68081bfa7d91973934>")[0].replace("<think_never_used_51bce0c785ca2f68081bfa7d91973934>", "")
                })
            messages.append({
                "role": "tool",
                "content": [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{images[image_num]}"}}],
                "tool_call_id": "1"
            })
            image_num += 1
        else:
            messages.append({
                "role": "tool",
                "content": [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{images[image_num]}"}}],
                "tool_call_id": "1"
            })
            image_num += 1

        messages = modify_conversations(messages)
        try_times = 3
        prediction = None
        while True:
            if try_times <= 0:
                print(f"Reach max retry times to fetch response from client, as error flag.")
                raise ValueError("Client error")
            try:
                logger.info(f"Messages: {self.pretty_print_messages(messages[-1])}")
                prediction = self.inference_func(messages)
                break

            except Exception as e:
                print(f"Error when fetching response from client, with error:\n{e}")
                prediction = None
                try_times -= 1

        self.history_responses.append(prediction)
        
        try:
            parsed_responses = parse_xml_action_v3(prediction, GUI_TOOL_SCHEMAS)
            if "seed:tool_call" not in prediction and len(parsed_responses) == 0:
                return prediction, ["DONE"]
            if len(parsed_responses) == 0:
                raise ValueError("Parsing action error")
            
        except Exception as e:
            print(f"Parsing action error: {prediction}, with error:\n{e}")
            raise ValueError("Parsing action error")
            
        thoughts = prediction.split("</think_never_used_51bce0c785ca2f68081bfa7d91973934>")[0]
        self.thoughts.append(thoughts)
        actions = []
        for parsed_xml_action in parsed_responses:
            parsed_response = {
                "action_type": parsed_xml_action["function"],
                "action_inputs": parsed_xml_action["parameters"]
            }

            if parsed_response["action_type"] == FINISH_WORD:
                self.actions.append(actions)
                return prediction, ["DONE"]
            
            elif parsed_response["action_type"] == WAIT_WORD:
                self.actions.append(actions)
                return prediction, ["WAIT"]
            
            elif parsed_response["action_type"] == ENV_FAIL_WORD:
                self.actions.append(actions)
                return prediction, ["FAIL"]

            elif parsed_response["action_type"] == CALL_USER:
                self.actions.append(actions)
                return prediction, ["FAIL"]
            
            elif parsed_response["action_type"] == INFEASIBLE:
                self.actions.append(actions)
                return prediction, ["FAIL"]
            
            pyautogui_code = parsing_response_to_pyautogui_code(
                parsed_response,
                height,
                width,
                self.input_swap
            )
            actions.append(pyautogui_code)

        self.actions.append(actions)
    

        return prediction, actions
        