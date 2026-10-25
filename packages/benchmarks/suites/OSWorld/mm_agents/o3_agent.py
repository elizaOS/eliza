import base64
import logging
import os
import re
from io import BytesIO
from typing import Dict, List


import backoff
import openai
import requests
from PIL import Image
from requests.exceptions import SSLError
from mm_agents.prompts import O3_SYSTEM_PROMPT

logger = None
MAX_RETRY_TIMES = 10

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY",None) #"Your OpenAI API Key"

def encode_image(image_content):
    return base64.b64encode(image_content).decode("utf-8")

class O3Agent:
    def __init__(
        self,
        platform="ubuntu",
        model="o3",
        max_tokens=1500,
        client_password="password",
        action_space="pyautogui",
        observation_type="screenshot",
        max_steps=15
    ):
        self.platform = platform
        self.model = model
        self.max_tokens = max_tokens
        self.client_password = client_password
        self.action_space = action_space
        self.observation_type = observation_type
        assert action_space in ["pyautogui"], "Invalid action space"
        assert observation_type in ["screenshot"], "Invalid observation type"
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.observation_captions = []
        self.max_image_history_length = 5
        self.current_step = 1
        self.max_steps = max_steps

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Predict the next action(s) based on the current observation.
        """

        user_prompt = (
            f"""Please generate the next move according to the UI screenshot and instruction. And you can refer to the previous actions and observations for reflection.\n\nInstruction: {instruction}\n\n""")

        messages = [{
            "role": "system",
            "content": [{
                "type": "text",
                "text": O3_SYSTEM_PROMPT.format(
                    current_step=self.current_step,
                    max_steps=self.max_steps,
                    CLIENT_PASSWORD=self.client_password
                )
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
            # For older steps, use the observation caption instead of the image
            else:
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": f"Observation: {self.observation_captions[i]}"
                    }]
                })

            thought_messages = f"Thought:\n{self.thoughts[i]}"

            action_messages = f"Action:"
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

        response = self.call_llm(
            {
                "model": self.model,
                "messages": messages,
                "max_completion_tokens": self.max_tokens,
            },
            self.model,
        )

        logger.info(f"Output: {response}")
        codes = self.parse_code_from_planner_response(response)
        # Add retry logic if no codes were parsed
        retry_count = 0
        max_retries = MAX_RETRY_TIMES
        while not codes and retry_count < max_retries:
            logger.info(f"No codes parsed from planner response. Retrying ({retry_count+1}/{max_retries})...")
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": "You didn't generate valid actions. Please try again."}
                ]
            })
            response = self.call_llm(
                {
                    "model": self.model,
                    "messages": messages,
                    "max_completion_tokens": self.max_tokens,
                },
                self.model,
            )
            logger.info(f"Retry Planner Output: {response}")
            codes = self.parse_code_from_planner_response(response)
            retry_count += 1
            
        thought = self.parse_thought_from_planner_response(response)
        observation_caption = self.parse_observation_caption_from_planner_response(response)
        logger.info(f"Thought: {thought}")
        logger.info(f"Observation Caption: {observation_caption}")
        logger.info(f"Codes: {codes}")
        self.actions.append([codes])
        self.observations.append(obs)
        self.thoughts.append(thought)
        self.observation_captions.append(observation_caption)
        self.current_step += 1
        return response, codes
        
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

    def parse_code_from_planner_response(self, input_string: str) -> List[str]:

        input_string = "\n".join([line.strip() for line in input_string.split(';') if line.strip()])
        if input_string.strip() in ['WAIT', 'DONE', 'FAIL']:
            return [input_string.strip()]

        pattern = r"```(?:\w+\s+)?(.*?)```"
        matches = re.findall(pattern, input_string, re.DOTALL)
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

    @backoff.on_exception(
        backoff.constant,
        # here you should add more model exceptions as you want,
        # but you are forbidden to add "Exception", that is, a common type of exception
        # because we want to catch this kind of Exception in the outside to ensure
        # each example won't exceed the time limit
        (
            # General exceptions
            SSLError,
            requests.HTTPError,
            # OpenAI exceptions
            openai.RateLimitError,
            openai.BadRequestError,
            openai.InternalServerError,
            openai.APIConnectionError, 
            openai.APIError
        ),
        interval=30,
        max_tries=10,
    )
    def call_llm(self, payload, model):
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}"
        }
        logger.info("Generating content with GPT model: %s", model)
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
        )

        if response.status_code != 200:
            logger.error("Failed to call LLM: " + response.text)
            # Raise HTTPError to trigger backoff retry mechanism
            response.raise_for_status()
        else:
            return response.json()["choices"][0]["message"]["content"]

    def reset(self, _logger=None):
        global logger
        logger = (_logger if _logger is not None else
                  logging.getLogger("desktopenv.o3_agent"))

        self.thoughts = []
        self.action_descriptions = []
        self.actions = []
        self.observations = []
        self.observation_captions = []
