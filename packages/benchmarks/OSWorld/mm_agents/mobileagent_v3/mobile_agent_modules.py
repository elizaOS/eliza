from dataclasses import dataclass, field
from abc import ABC, abstractmethod

import copy
import re
import json
import time
import os

from typing import Dict, List, Optional, Tuple

import base64
from PIL import Image

import dashscope
from dashscope import MultiModalConversation

from openai import OpenAI
from io import BytesIO
import oss2
import uuid


def encode_image(image_content):
    return base64.b64encode(image_content).decode("utf-8")

def decode_image(base64_str, output_path):
    image_data = base64.b64decode(base64_str)
    with open(output_path, 'wb') as file:
        file.write(image_data)
    return output_path

def push_oss(image_path):
    access_key_id = os.environ['access_key_id']
    access_key_secret = os.environ['access_key_secret']
    endpoint = os.environ['endpoint']
    bucket_name = os.environ['bucket_name']
    auth = oss2.Auth(access_key_id, access_key_secret)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    image = Image.open(image_path)
    if image.mode != 'RGB':
        image = image.convert('RGB')
    output_stream = BytesIO()
    image.save(output_stream, format='JPEG')
    unique_string = image_path.split("/")[-1]
    part_img_ossfile_path = f"images/{unique_string}"
    bucket.put_object(part_img_ossfile_path, output_stream.getvalue())

def get_image_url(image):
    base64_image = image
    image_name = str(uuid.uuid4())
    os.makedirs("images", exist_ok=True)
    image_path = decode_image(base64_image, f"images/{image_name}.png")
    push_oss(image_path)
    url_prefix = os.environ['url_prefix']
    image_url = url_prefix + image_path.split('/')[-1]
    return image_url


class LMMEngineDash:
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    def generate(
        self,
        messages,
        temperature=0.0,
        top_p=0.8,
        repetition_penalty=1.05,
        max_new_tokens=512,
        **kwargs
    ):
        dashscope.api_key = self.api_key
        if "pre" in self.model:
            dashscope.base_http_api_url = "https://poc-dashscope.aliyuncs.com/api/v1"
            dashscope.base_websocket_api_url = "https://poc-dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        
        max_retries = 10
        for i in range(max_retries):
            try:
                completion = MultiModalConversation.call(
                    model=self.model,
                    messages=messages,
                    max_tokens=max_new_tokens if max_new_tokens else 2048,
                    temperature=temperature,
                    top_p=top_p,
                    vl_high_resolution_images=True
                )
                # print(completion.output.choices[0].message.content[0]['text'])
                return completion.output.choices[0].message.content[0]['text']
            except Exception as e:
                print(f"Attempt {i+1} failed: {e}")
            time.sleep(3)

class LMMEngineOpenai:
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    def generate(
        self,
        messages,
        temperature=0.0,
        top_p=0.8,
        repetition_penalty=1.05,
        max_new_tokens=512,
        **kwargs
    ):
        max_retries = 10
        for i in range(max_retries):
            try:
                completion = self.llm_client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    max_tokens=max_new_tokens if max_new_tokens else 2048,
                    temperature=temperature,
                    top_p=top_p,
                    extra_body={'skip_special_tokens': False, 'top_k': -1},
                )
                # print(completion.choices[0].message.content)
                return completion.choices[0].message.content
            except Exception as e:
                print(f"Attempt {i+1} failed: {e}")
            time.sleep(3)

class LMMAgent:
    def __init__(self, engine_params=None, system_prompt=None):
        engine_type = engine_params.get("engine_type")
        self.engine_type = engine_type
        if engine_type == "dash":
            self.engine = LMMEngineDash(**engine_params)
        else:
            self.engine = LMMEngineOpenai(**engine_params)
        self.messages = []
        if system_prompt:
            self.add_system_prompt(system_prompt)
        else:
            self.add_system_prompt("You are a helpful assistant.")
        
    def encode_image(self, image_content):
        if isinstance(image_content, str):
            with open(image_content, "rb") as image_file:
                return base64.b64encode(image_file.read()).decode("utf-8")
        else:
            return base64.b64encode(image_content).decode("utf-8")

    def reset(self):
        self.messages = [
            {
                "role": "system",
                "content": [{"type": "text", "text": self.system_prompt} if self.engine_type=='openai' else {"text": self.system_prompt}],
            }
        ]

    def add_system_prompt(self, system_prompt):
        self.system_prompt = system_prompt
        if len(self.messages) > 0:
            self.messages[0] = {
                "role": "system",
                "content": [{"type": "text", "text": self.system_prompt} if self.engine_type=='openai' else {"text": self.system_prompt}],
            }
        else:
            self.messages.append(
                {
                    "role": "system",
                    "content": [{"type": "text", "text": self.system_prompt} if self.engine_type=='openai' else {"text": self.system_prompt}],
                }
            )

    def add_message(
        self,
        text_content,
        image_content=None,
        role=None,
    ):
        if role != "user":
            if self.messages[-1]["role"] == "system":
                role = "user"
            elif self.messages[-1]["role"] == "user":
                role = "assistant"
            elif self.messages[-1]["role"] == "assistant":
                role = "user"

        if self.engine_type == "dash":
            message = {
                "role": role,
                "content": [{"text": text_content}]
            }
            
            if image_content:
                if isinstance(image_content, list):
                    for image in image_content:
                        base64_image = self.encode_image(image)
                        message["content"].append(
                            {"image": f"data:image/png;base64,{base64_image}"}
                        )
                else:
                    base64_image = self.encode_image(image_content)
                    message["content"].append(
                        {"image": f"data:image/png;base64,{base64_image}"}
                    )
            self.messages.append(message)

        else:
            message = {
                "role": role,
                "content": [{"type": "text", "text": text_content}],
            }

            if image_content:
                if isinstance(image_content, list):
                    for image in image_content:
                        base64_image = self.encode_image(image)
                        message["content"].append(
                            # {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                            {"type": "image_url", "image_url": {"url": get_image_url(base64_image)}}
                        )
                else:
                    base64_image = self.encode_image(image_content)
                    message["content"].append(
                        # {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                        {"type": "image_url", "image_url": {"url": get_image_url(base64_image)}}
                    )
            self.messages.append(message)

    def get_response(
        self,
        user_message=None,
        image=None,
        messages=None,
        temperature=0.0,
        max_new_tokens=None,
        **kwargs,
    ):
        if messages is None:
            messages = self.messages
        if user_message:
            if self.engine_type == 'dash':
                messages.append(
                    {"role": "user", "content": [{"text": user_message}]}
                )
            else:
                messages.append(
                    {"role": "user", "content": [{"type": "text", "text": user_message}]}
                )
        return self.engine.generate(
            messages,
            temperature=temperature,
            max_new_tokens=max_new_tokens,
            **kwargs,
        )


class BaseModule:
    def __init__(self, engine_params: Dict, platform: str):
        self.engine_params = engine_params
        self.platform = platform

    def _create_agent(
        self, system_prompt: str = None, engine_params: Optional[Dict] = None
    ) -> LMMAgent:
        """Create a new LMMAgent instance"""
        agent = LMMAgent(engine_params or self.engine_params)
        if system_prompt:
            agent.add_system_prompt(system_prompt)
        return agent


@dataclass
class InfoPool:
    """Keeping track of all information across the agents."""

    # User input / accumulated knowledge
    instruction: str = ""
    additional_knowledge: str = ""

    # Working memory
    summary_history: list = field(default_factory=list)  # List of action descriptions
    action_history: list = field(default_factory=list)  # List of actions
    action_outcomes: list = field(default_factory=list)  # List of action outcomes
    error_descriptions: list = field(default_factory=list)

    last_summary: str = ""  # Last action description
    last_action: str = ""  # Last action
    last_action_thought: str = ""  # Last action thought
    important_notes: str = ""
    
    error_flag_plan: bool = False # if an error is not solved for multiple attempts with the executor
    error_description_plan: bool = False # explanation of the error for modifying the plan

    # Planning
    plan: str = ""
    progress_status: str = ""
    progress_status_history: list = field(default_factory=list)
    finish_thought: str = ""
    current_subgoal: str = ""
    err_to_manager_thresh: int = 2

    future_tasks: list = field(default_factory=list)


class Grounding(BaseModule):
    def __init__(self, engine_params, platform='Ubuntu'):
        super().__init__(engine_params, platform)

    def predict(self, ref_expr, image_list):
        agent = self._create_agent()
        prompt = f"Query:{ref_expr}\nOutput only the coordinate of one point in your response.\n"
        agent.add_message(text_content=prompt, image_content=image_list, role="user")
        response = agent.get_response()
        agent.add_message(text_content=response, role="assistant")
        numericals = re.findall(r"\d+", response)
        assert len(numericals) >= 2
        return [int(numericals[0]), int(numericals[1])], agent.messages

Manager_tips = ""

class Manager(BaseModule):
    def __init__(self, engine_params, platform='Ubuntu'):
        super().__init__(engine_params, platform)

    def predict(self, prompt, image_list):
        agent = self._create_agent()
        agent.add_message(text_content=prompt, image_content=image_list, role="user")
        response = agent.get_response()
        agent.add_message(text_content=response, role="assistant")
        return response, agent.messages

    def get_prompt(self, info_pool: InfoPool, args, rag_info="", guide="") -> str:
        prompt = "You are an agent who can operate an Ubuntu computer on behalf of a user. Your goal is to track progress and devise high-level plans to achieve the user's requests.\n\n"
        prompt += "### User Request ###\n"
        prompt += f"{info_pool.instruction}\n\n"

        if info_pool.plan == "":
            # first time planning
            prompt += "---\n"
            prompt += "Make a high-level plan to achieve the user's request. If the request is complex, break it down into subgoals. The screenshot displays the starting state of the computer.\n"

            prompt += "##### Important Notes #####\n"
            prompt += "1. Before generating your plan, carefully observe and understand the current state of the computer.\n"
            prompt += "2. Your plan should contain only necessary steps; however, please include information useful for executing the subgoal in the 'info' field.\n"
            prompt += "3. Do not include verification steps in your plan. Steps that confirm or validate other subtasks should not be included.\n"
            prompt += "4. Do not include optional steps in your plan.\n"

            prompt += "Provide your output in the following format which contains three parts:\n\n"
            prompt += "### Thought ###\n"
            prompt += "A detailed explanation of your rationale for the plan and subgoals.\n\n"
            prompt += "### Plan ###\n"
            prompt += "1. {'name': 'brief description of the first subgoal.', 'info': 'detailed information about executing the first subgoal.'}\n"
            prompt += "2. {'name': 'brief description of the second subgoal.', 'info': 'detailed information about executing the second subgoal.'}\n"
            prompt += "...\n\n"
            prompt += "### Current Subgoal ###\n"
            prompt += "The first subgoal's name you should work on.\n\n"
            
        else:
            # continue planning
            prompt += "### Current Plan ###\n"
            prompt += f"{info_pool.plan}\n\n" 
            prompt += "### Previous Subgoal ###\n" 
            prompt += f"{info_pool.current_subgoal}\n\n" 
            prompt += f"### Last Action ###\n"
            prompt += f"{info_pool.last_action}\n\n" 
            prompt += f"### Progress Status ###\n"
            prompt += f"{info_pool.progress_status}\n\n" 
            if Manager_tips != "":
                prompt += "### Important Notes ###\n"
                prompt += f"{Manager_tips}\n"
            if info_pool.important_notes != "":
                prompt += f"{info_pool.important_notes}\n\n"

            if info_pool.action_history != []:
                prompt += "### Latest Action History ###\n"
                prompt += "Recent actions you took previously and whether they were successful:\n"
                num_actions = min(5, len(info_pool.action_history))
                latest_actions = info_pool.action_history[-num_actions:]
                latest_summary = info_pool.summary_history[-num_actions:]
                latest_outcomes = info_pool.action_outcomes[-num_actions:]
                error_descriptions = info_pool.error_descriptions[-num_actions:]
                action_log_strs = []
                for act, summ, outcome, err_des in zip(latest_actions, latest_summary, latest_outcomes, error_descriptions):
                    if outcome == "A":
                        action_log_str = f"Action: {act} | Description: {summ} | Outcome: Successful\n"
                    else:
                        action_log_str = f"Action: {act} | Description: {summ} | Outcome: Failed | Feedback: {err_des}\n"
                    prompt += action_log_str
                    action_log_strs.append(action_log_str)
                
                prompt += "\n"

            if info_pool.error_flag_plan:
                prompt += "### Potentially Stuck! ###\n"
                prompt += "You have encountered several failed attempts. Here are some logs:\n"
                k = info_pool.err_to_manager_thresh
                recent_actions = info_pool.action_history[-k:]
                recent_summaries = info_pool.summary_history[-k:]
                recent_err_des = info_pool.error_descriptions[-k:]
                for i, (act, summ, err_des) in enumerate(zip(recent_actions, recent_summaries, recent_err_des)):
                    prompt += f"- Attempt: Action: {act} | Description: {summ} | Outcome: Failed | Feedback: {err_des}\n"

            prompt += "---\n"
            prompt += "Carefully assess the current status and the provided screenshot. Check if the current plan needs to be revised.\n Determine if the task has been fully completed. If you are confident that no further actions are required, mark the task as \"Finished\" in your output. If the task is not finished, outline the next steps. If you are stuck with errors, think step by step about whether the overall plan needs to be revised to address the error.\n"
            prompt += "NOTE: If the current situation prevents proceeding with the original plan or requires clarification from the user, make reasonable assumptions and revise the plan accordingly. Act as though you are the user in such cases.\n"
            
            prompt += "##### Important Notes #####\n"
            prompt += "1. Before generating your plan, carefully observe and understand the current state of the computer.\n"
            prompt += "2. Your plan should contain only necessary steps; however, please include information useful for executing the subgoal in the 'info' field.\n"
            prompt += "3. Do not include verification steps in your plan. Steps that confirm or validate other subtasks should not be included.\n"
            prompt += "4. Do not include optional steps in your plan.\n"

            prompt += "Provide your output in the following format, which contains three parts:\n\n"
            prompt += "### Thought ###\n"
            prompt += "An explanation of your rationale for the updated plan and subgoals.\n\n"
            prompt += "### Plan ###\n"
            prompt += "1. {'name': 'brief description of the first subgoal.', 'info': 'detailed information about executing the first subgoal.'}\n"
            prompt += "2. {'name': 'brief description of the second subgoal.', 'info': 'detailed information about executing the second subgoal.'}\n"
            prompt += "...\n\n"
            prompt += "### Current Subgoal ###\n"
            prompt += "The next subgoal's name to work on. If all subgoals are completed, write \"Finished\"."

        if rag_info != "" and guide == "":
            prompt += f"Below are some retrieved knowledge you may refer to if you think they are useful: {rag_info}"
        if rag_info != "" and guide != "":
            prompt += f"Here is a description of an action trajectory that successfully completed the user's instruction, for your reference.\n{guide}\n\n"
            prompt += "Additionally, here is some relevant information retrieved from the internet regarding this task. However, please note that this information may not be accurate and may include unnecessary or incorrect steps. You should rely on the description of the successful trajectory above and extract useful information from the online knowledge.\n"
            prompt += f"{rag_info}\n\n"

        return prompt

    def parse_response(self, response: str) -> dict:
        thought = response.split("### Thought ###")[-1].split("### Plan ###")[0].replace("\n", " ").replace("  ", " ").strip()
        plan = response.split("### Plan ###")[-1].split("### Current Subgoal ###")[0].replace("\n", " ").replace("  ", " ").strip()
        current_subgoal = response.split("### Current Subgoal ###")[-1].replace("\n", " ").replace("  ", " ").strip()
        return {"thought": thought, "plan": plan, "current_subgoal": current_subgoal}



ATOMIC_ACTION_SIGNITURES_COMPUTER = {
    'click': {
        "arguments": ["coordinate"],
        "description": lambda info: "Click the point on the screen with specified (x, y) coordinates. Usage Example: {\"action\": \"click\", \"coordinate\": [x, y]}"
    },
    'double_click': {
        "arguments": ["coordinate"],
        "description": lambda info: "Double click on the position (x, y) on the screen. Usage Example: {\"action\": \"double_click\", \"coordinate\": [x, y]}"
    },
    'right_click': {
        "arguments": ["coordinate"],
        "description": lambda info: "Right-click using the mouse on the position (x, y) on the screen. Usage Example: {\"action\": \"double_click\", \"coordinate\": [x, y]}"
    },
    'type': {
        "arguments": ["coordinate", "text", "clear", "enter"],
        "description": lambda info: "Type text into the position (x, y) on the screen. Use escape characters \\', \\\", and \\n in the `text` part to ensure we can parse the content in normal python string format. If you want to clear the existing content, set the `clear` parameter to 1; otherwise, set it to 0. If you want to press `enter` after input, set the `enter` parameter to 1; otherwise, set it to 0. Usage Example: {\"action\": \"type\", \"coordinate\": [x, y], \"text\": \"the text you want to type\", \"clear\": 1, \"enter\": 1}"
    },
    'hotkey': {
        "arguments": ["keys"],
        "description": lambda info: "Press a hotkey combination. The `keys` parameter is a list of keys represented as a string, such as \"['ctrl', 'c']\". Usage Example: {\"action\": \"hotkey\", \"keys\": \"['ctrl', 'c']\"}"
    },
    'scroll': {
        "arguments": ["coordinate", "value"],
        "description": lambda info: "Scroll at the position (x, y) on the screen. The `value` parameter can be positive (scroll up) or negative (scroll down), which is usually set to 5 or -5. Usage Example: {\"action\": \"scroll\", \"coordinate\": [x, y], \"value\": 5}"
    },
    'wait': {
        "arguments": ["time"],
        "description": lambda info: "Wait for a specified amount of time, such as 3s. Usage Example: {\"action\": \"wait\", \"time\": 3}"
    },
    'drag': {
        "arguments": ["coordinate", "coordinate2"],
        "description": lambda info: "drag from the position with coordinate to the position with coordinate2. Usage Example: {\"action\": \"drag\", \"coordinate\": [x1, y1], \"coordinate2\": [x2, y2]}"
    },
    'set_cell_values':{
        "arguments": ["cell_values", "file_name", "sheet_name"],
        "description": lambda info: "set individual cell values (a Dict) in the sheet with sheet_name and in the spreadsheet with file_name. Usage Example: {\"action\": \"set_cell_value\", \"cell_values\": {\"A2\": \"hello\"}, \"file_name\": 'Untitled 1', \"sheet_name\": 'Sheet1'}"
    }
}


ATOMIC_ACTION_SIGNITURES_COMPUTER_2stage = {
    'click': {
        "arguments": ["element_description"],
        "description": lambda info: "Click on the described element. This description should be at least a full sentence. Usage Example: {\"action\": \"click\", \"element_description\": \"a detailed description of the element\"}"
    },
    'double_click': {
        "arguments": ["element_description"],
        "description": lambda info: "Double click on the described element. This description should be at least a full sentence. Usage Example: {\"action\": \"double_click\", \"element_description\": \"a detailed description of the element\"}"
    },
    'right_click': {
        "arguments": ["element_description"],
        "description": lambda info: "Right-click using the mouse on the described element. This description should be at least a full sentence. Usage Example: {\"action\": \"right_click\", \"element_description\": \"a detailed description of the element\"}"
    },
    'type': {
        "arguments": ["element_description", "text", "clear", "enter"],
        "description": lambda info: "Type text into the described element (e.g. search box) on the screen. This description should be at least a full sentence. Use escape characters \\', \\\", and \\n in the `text` part to ensure we can parse the content in normal python string format. If you want to clear the existing content, set the `clear` parameter to 1; otherwise, set it to 0. If you want to press `enter` after input, set the `enter` parameter to 1; otherwise, set it to 0. Usage Example: {\"action\": \"type\", \"element_description\": \"a detailed description of the element\", \"text\": \"the text you want to type\", \"clear\": 1, \"enter\": 1}"
    },
    'hotkey': {
        "arguments": ["keys"],
        "description": lambda info: "Press a hotkey combination. The `keys` parameter is a list of keys represented as a string, such as \"['ctrl', 'c']\". Usage Example: {\"action\": \"hotkey\", \"keys\": \"['ctrl', 'c']\"}"
    },
    'scroll': {
        "arguments": ["element_description", "value"],
        "description": lambda info: "Scroll at the described element on the screen. This description should be at least a full sentence. The `value` parameter can be positive (scroll up) or negative (scroll down), which is usually set to 5 or -5. Usage Example: {\"action\": \"scroll\", \"element_description\": \"a detailed description of the element\", \"value\": 5}"
    },
    'wait': {
        "arguments": ["time"],
        "description": lambda info: "Wait for a specified amount of time, such as 3s. Usage Example: {\"action\": \"wait\", \"time\": 3}"
    },
    'drag': {
        "arguments": ["element1_description", "element2_description"],
        "description": lambda info: "drag from the position of element1 to the position of element2. Usage Example: {\"action\": \"drag\", \"element1_description\": \"a detailed description of the element1\", \"element2_description\": \"a detailed description of the element2\"}"
    },
    'set_cell_values':{
        "arguments": ["cell_values", "file_name", "sheet_name"],
        "description": lambda info: "set individual cell values (a Dict) in the sheet with sheet_name and in the spreadsheet with file_name. Usage Example: {\"action\": \"set_cell_value\", \"cell_values\": {\"A2\": \"hello\"}, \"file_name\": 'Untitled 1', \"sheet_name\": 'Sheet1'}"
    }
}


class Executor(BaseModule):
    def __init__(self, engine_params, platform='Ubuntu'):
        super().__init__(engine_params, platform)

    def predict(self, prompt, image_list):
        agent = self._create_agent()
        agent.add_message(text_content=prompt, image_content=image_list, role="user")
        num_try = 5
        for i in range(num_try):
            try:
                response = agent.get_response()
                parsed_response = self.parse_response(response)
                action_str = parsed_response['action'].split('```json')[-1].split('```')[0]
                action_dict = json.loads(action_str)
                break
            except:
                continue

        agent.add_message(text_content=response, role="assistant")
        return response, agent.messages

    def get_prompt(self, info_pool: InfoPool, grounding_stage) -> str:
        prompt = "You are an agent who can operate an Ubuntu computer on behalf of a user. Your goal is to decide the next action to perform based on the current state of the phone and the user's request.\n\n"

        prompt += "### User Request ###\n"
        prompt += f"{info_pool.instruction}\n\n"

        prompt += "### Overall Plan ###\n"
        prompt += f"{info_pool.plan}\n\n"

        prompt += "### Progress Status ###\n"
        if info_pool.progress_status != "":
            prompt += f"{info_pool.progress_status}\n\n"
        else:
            prompt += "No progress yet.\n\n"

        prompt += "### Current Subgoal ###\n"
        prompt += f"{info_pool.current_subgoal}\n\n"

        if info_pool.additional_knowledge != "":
            prompt += "### Guidelines ###\n"
            prompt += f"{info_pool.additional_knowledge}\n"

        prompt += "---\n"
        prompt += "Carefully examine all the information provided above and decide on the next action to perform. If you notice an unsolved error in the previous action, think as a human user and attempt to rectify them. You must choose your action from one of the atomic actions.\n\n"
        
        prompt += "#### Atomic Actions ####\n"
        prompt += "The atomic action functions are listed in the format of `action(arguments): description` as follows:\n"


        if grounding_stage > 0:
            for action, value in ATOMIC_ACTION_SIGNITURES_COMPUTER_2stage.items():
                prompt += f"- {action}({', '.join(value['arguments'])}): {value['description'](info_pool)}\n"
        else:
            for action, value in ATOMIC_ACTION_SIGNITURES_COMPUTER.items():
                prompt += f"- {action}({', '.join(value['arguments'])}): {value['description'](info_pool)}\n"
        
        prompt += "\n"

        prompt += "### Latest Action History ###\n"
        if info_pool.action_history != []:
            prompt += "Recent actions you took previously and whether they were successful:\n"
            num_actions = min(5, len(info_pool.action_history))
            latest_actions = info_pool.action_history[-num_actions:]
            latest_summary = info_pool.summary_history[-num_actions:]
            latest_outcomes = info_pool.action_outcomes[-num_actions:]
            error_descriptions = info_pool.error_descriptions[-num_actions:]
            action_log_strs = []
            for act, summ, outcome, err_des in zip(latest_actions, latest_summary, latest_outcomes, error_descriptions):
                if outcome == "A":
                    action_log_str = f"Action: {act} | Description: {summ} | Outcome: Successful\n"
                else:
                    action_log_str = f"Action: {act} | Description: {summ} | Outcome: Failed | Feedback: {err_des}\n"
                prompt += action_log_str
                action_log_strs.append(action_log_str)
            
            prompt += "\n"
            
        else:
            prompt += "No actions have been taken yet.\n\n"

        prompt += "---\n"
        prompt += "Provide your output in the following format, which contains three parts:\n"
        prompt += "### Thought ###\n"
        
        prompt += "Provide a detailed explanation of your rationale for the chosen action.\n\n"

        prompt += "### Action ###\n"
        prompt += "Choose only one action or shortcut from the options provided. IMPORTANT: Do NOT return invalid actions like null or stop. Do NOT repeat previously failed actions multiple times.\n"
        prompt += "You must provide your decision using a valid JSON format specifying the `action` and the arguments of the action." 
        
        prompt += "### Description ###\n"
        prompt += "A brief description of the chosen action and the expected outcome."
        return prompt

    def parse_response(self, response: str) -> dict:
        thought = response.split("### Thought ###")[-1].split("### Action ###")[0].replace("\n", " ").replace("  ", " ").strip()
        action = response.split("### Action ###")[-1].split("### Description ###")[0].replace("\n", " ").replace("  ", " ").strip()
        description = response.split("### Description ###")[-1].replace("\n", " ").replace("  ", " ").strip()
        return {"thought": thought, "action": action, "description": description}


class Reflector(BaseModule):
    def __init__(self, engine_params, platform='Ubuntu'):
        super().__init__(engine_params, platform)

    def predict(self, prompt, image_list):
        agent = self._create_agent()
        agent.add_message(text_content=prompt, image_content=image_list, role="user")
        response = agent.get_response()
        agent.add_message(text_content=response, role="assistant")
        return response, agent.messages

    def get_prompt(self, info_pool: InfoPool) -> str:
        prompt = "You are an agent who can operate an Ubuntu computer on behalf of a user. Your goal is to verify whether the last action produced the expected behavior and to keep track of the overall progress.\n\n"

        prompt += "### User Request ###\n"
        prompt += f"{info_pool.instruction}\n\n"

        prompt += "### Progress Status ###\n"
        if info_pool.progress_status != "":
            prompt += f"{info_pool.progress_status}\n\n"
        else:
            prompt += "No progress yet.\n\n"

        prompt += "### Current Subgoal ###\n"
        prompt += f"{info_pool.current_subgoal}\n\n"

        prompt += "---\n"
        prompt += "The two attached images are computer screenshots taken before and after your last action. You should observe them carefully to verify whether the action achieves the expected result.\n"


        prompt += "---\n"
        prompt += "### Latest Action ###\n"
        prompt += f"Action: {info_pool.last_action}\n"
        prompt += f"Expectation: {info_pool.last_summary}\n\n"

        prompt += "---\n"
        prompt += "Carefully examine the information provided above to determine whether the last action produced the expected behavior. If the action was successful, update the progress status accordingly. If the action failed, identify the failure mode and provide reasoning on the potential reason causing this failure. Note that for the `scroll` action, it may take multiple attempts to display the expected content. Thus, for a `scroll` action, if the screen shows new content, it usually meets the expectation.\nPro Tip: In rare cases, the UI might not visibly change even if a click action is performed correctly — for example, when clicking on a color before drawing. In such situations, you can assume the action was successful and proceed — for example, by drawing a line.\n\n"

        prompt += "When the user instruction involves adjusting some values (e.g., brightness, contrast, steps), be sure to check if the values meet expectations after the operation.\n\n"

        prompt += "Provide your output in the following format containing four parts:\n\n"

        prompt += "### Screenshot Difference ###\n"
        prompt += "Describte the main differences between the screenshots taken before and after the last action.\n"

        prompt += "### Outcome ###\n"
        prompt += "Choose from the following options. Give your response as \"A\", \"B\" or \"C\":\n"
        prompt += "A: Successful or Partially Successful. The result of the last action meets the expectation.\n"
        prompt += "B: Failed. The last action results in a wrong page. I need to return to the previous state.\n"
        prompt += "C: Failed. The last action produces no changes.\n\n"

        prompt += "### Error Description ###\n"
        prompt += "If the action failed, provide a detailed description of the error and the potential reason causing this failure. If the action succeeded, put \"None\" here.\n\n"

        prompt += "### Progress Status ###\n"
        prompt += "If the action was successful or partially successful, update the progress status. If the action failed, copy the previous progress status.\n"

        return prompt

    def parse_response(self, response: str) -> dict:
        outcome = response.split("### Outcome ###")[-1].split("### Error Description ###")[0].replace("\n", " ").replace("  ", " ").strip()
        error_description = response.split("### Error Description ###")[-1].split("### Progress Status ###")[0].replace("\n", " ").replace("  ", " ").strip()
        progress_status = response.split("### Progress Status ###")[-1].replace("\n", " ").replace("  ", " ").strip()
        return {"outcome": outcome, "error_description": error_description, "progress_status": progress_status}
