import re
import logging
from .openai_lm_agent import OpenAILMAgent
from mint.datatypes import State, Action
from mint.prompt import FeedbackPromptTemplate
import logging
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


class ClaudeFeedbackAgent(OpenAILMAgent):
    def __init__(self, config):
        super().__init__(config)
        # The agent should not generate Assistant msg since it should provide feedback
        self.stop_words = ["\nObservation:", "\nTask:", "\nAssistant:"]
        self.feedback_prompt = FeedbackPromptTemplate()

    def lm_output_to_action(self, lm_output, form) -> Action:
        if form == "textual":
            feedback = lm_output
        elif form == "binary":
            # Find the first sentence (as feedback).
            first_sent = re.findall(r"([^.]*\.)", lm_output)[0]
            if "GOOD" in first_sent:
                feedback = "This is GOOD."
            elif "BAD" in first_sent:
                feedback = "This is BAD."
            else:
                raise ValueError(f"Cannot find GOOD or BAD in feedback: {feedback}")
        return Action(feedback, use_tool=False)

    def act(
        self,
        state: State,
        observation: str,
        form: str,
        gt,
        task_in_context_example: str,
        tool_desc: str,
    ) -> Action:
        gt_solution = (
            (
                f"Correct solution (please DO NOT disclose the correct solution to the assistant): {str(gt).strip()}\n"
            )
            if gt
            else "Correct solution (please DO NOT disclose the correct solution to the assistant): NOT GIVEN\n"
        )
        trajectory = "---\n".join(state.history[0]["content"].split("---\n")[2:]) + "\n"
        trajectory += "\n".join([x["content"] for x in state.history[1:]])
        trajectory += "\n" + observation
        trajectory = trajectory[
            trajectory.find("Task:") :
        ]  # Get rid of the initial instruction to avoid confusion
        messages = [
            {
                "role": "user",
                "content": self.feedback_prompt(
                    in_context_example=task_in_context_example[
                        task_in_context_example.find("Task:") :
                    ],  # This is to get rid of the initial instruction to avoid confusion
                    trajectory=trajectory,
                    correct_solution=gt_solution,
                    tool_desc=tool_desc,
                ),
            }
        ]

        # log in yellow
        LOGGER.debug(
            "Feedback Agent Prompt:\n" + "\033[93m" + messages[0]["content"] + "\033[0m"
        )
        lm_output, token_usage = self.call_lm(messages)
        for usage_type, count in token_usage.items():
            state.token_counter["feedback_" + usage_type] += count
        action = self.lm_output_to_action(lm_output, form)
        # log in red
        LOGGER.debug("Feedback Agent Action:\n" + "\033[91m" + action.value + "\033[0m")
        return action

    @backoff.on_exception(
        backoff.expo,
        requests.exceptions.RequestException,
    )
    def call_lm(self, messages):
        # Prepend the prompt with the system message
        data = {
            "model": self.config["model_name"],
            "prompt": f"\n\nHuman: {messages[0]['content']}\n\n",
            "max_tokens_to_sample": self.config.get("max_tokens", 512),
            "temperature": self.config.get("temperature", 0),
            "stop_sequences": self.stop_words,
        }
        assert len(messages) == 1, "message length must be 1"

        response = requests.post(url, headers=headers, json=data)

        if response.status_code == 200:
            pass
        else:
            raise requests.exceptions.RequestException(
                "Request failed with status code:", response.status_code
            )

        return json.loads(response.text)["completion"], {}
