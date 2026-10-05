from .base import LMAgent
import logging
import traceback
from mint.datatypes import Action
import backoff
import requests
import os
import json

LOGGER = logging.getLogger("MINT")

url = "https://api.anthropic.com/v1/complete"
headers = {
    "accept": "application/json",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-api-key": os.environ.get("ANTHROPIC_API_KEY", None),
}


class ClaudeLMAgent(LMAgent):
    def __init__(self, config):
        super().__init__(config)
        assert "model_name" in config.keys()
        self.stop_words = [
            "Observation:",
            "Expert feedback:",
            "Task:",
            "---",
            "\n\nHuman:",
        ]

    @backoff.on_exception(
        backoff.expo,
        requests.exceptions.RequestException,
    )
    def call_lm(self, messages):
        # Prepend the prompt with the system message
        data = {
            "model": self.config["model_name"],
            "prompt": "",
            "max_tokens_to_sample": self.config.get("max_tokens", 512),
            "temperature": self.config.get("temperature", 0),
            "stop_sequences": self.stop_words,
        }
        for message in messages:
            if message["role"] == "user":
                data["prompt"] += f"\n\nHuman: {message['content']}"
            else:
                data["prompt"] += f"\n\nAssistant: {message['content']}"
        assert len(messages) % 2 == 1, "messages must be odd length"
        data["prompt"] += "\n\nAssistant:"

        response = requests.post(url, headers=headers, json=data)

        if response.status_code == 200:
            pass
        else:
            raise requests.exceptions.RequestException(
                "Request failed with status code:", response.status_code
            )

        return json.loads(response.text)["completion"], {}

    def act(self, state):
        messages = state.history
        lm_output, token_usage = self.call_lm(messages)
        for usage_type, count in token_usage.items():
            state.token_counter[usage_type] += count
        action = self.lm_output_to_action(lm_output)
        return action
        # except Exception as e:
        #     tb = traceback.format_exc()
        #     return Action(None, False, error="Unknown error")
