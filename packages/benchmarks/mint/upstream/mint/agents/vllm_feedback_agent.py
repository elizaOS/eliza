from .openai_lm_agent import OpenAILMAgent
import openai
import openai.error
import logging
import traceback
from mint.datatypes import State, Action
import backoff
import re
from mint.prompt import FeedbackPromptTemplate

LOGGER = logging.getLogger("MINT")
# REMEMBER to RUN ALL MODELS


class VLLMFeedbackAgent(OpenAILMAgent):
    """Inference for open-sourced models with a unified interface with OpenAI's API."""

    def __init__(self, config):
        super().__init__(config)
        assert (
            "openai.api_base" in config.keys()
        ), "missing openai.api_base to connect to server"
        self.api_base = config["openai.api_base"]
        self.api_key = "EMPTY"
        LOGGER.info("remember to openup the server following docs/SERVING.md")

        if "override" in config:
            self.assistant_keyword = config["override"].get("assistant", "Assistant")
            self.human_keyword = config["override"].get("human", "Human")
            LOGGER.info(
                f"Overriding assistant/human keyword for the [Feedback Model] to {self.assistant_keyword}/{self.human_keyword}"
            )
        else:
            self.assistant_keyword = "Assistant"
            self.human_keyword = "Human"

        self.stop_words = [
            "\nObservation:",
            "\nTask:",
            f"\n{self.assistant_keyword}:",
            f"\n{self.human_keyword}:"
        ]

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
        try:
            gt_solution = (
                (
                    f"Correct solution (please DO NOT disclose the correct solution to the assistant): {str(gt).strip()}\n"
                )
                if gt
                else "Correct solution (please DO NOT disclose the correct solution to the assistant): NOT GIVEN\n"
            )
            trajectory = (
                "---\n".join(state.history[0]["content"].split("---\n")[2:]) + "\n"
            )
            trajectory += "\n".join([x["content"] for x in state.history[1:]])
            trajectory += "\n" + observation
            trajectory = trajectory[
                trajectory.find("Task:") :
            ]  # Get rid of the initial instruction to avoid confusion

            feedback_prompt = self.feedback_prompt(
                in_context_example=task_in_context_example[
                    task_in_context_example.find("Task:") :
                ],  # This is to get rid of the initial instruction to avoid confusion
                trajectory=trajectory,
                correct_solution=gt_solution,
                tool_desc=tool_desc,
            )
            # try to map the assistant/human keyword to avoid collision with the LLM's keyword
            feedback_prompt = feedback_prompt.replace("Assistant:", f"{self.assistant_keyword}:")
            feedback_prompt = feedback_prompt.replace("Human:", f"{self.human_keyword}:")
            messages = [
                {
                    "role": "user",
                    "content": feedback_prompt
                }
            ]

            # log in yellow
            LOGGER.debug(
                "Feedback Agent Prompt:\n"
                + "\033[93m"
                + messages[0]["content"]
                + "\033[0m"
            )
            lm_output, token_usage = self.call_lm(messages)
            for usage_type, count in token_usage.items():
                state.token_counter["feedback_" + usage_type] += count
            action = self.lm_output_to_action(lm_output, form)
            # log in red
            LOGGER.debug(
                "Feedback Agent Action:\n" + "\033[91m" + action.value + "\033[0m"
            )
            return action
        except openai.error.InvalidRequestError:
            tb = traceback.format_exc()
            return Action(f"", False, error=f"InvalidRequestError\n{tb}")
        except Exception as e:
            tb = traceback.format_exc()
            return Action(f"", False, error=f"Unknown error\n{tb}")

    def format_prompt(self, messages):
        """Format messages into a prompt for the model."""
        prompt = ""
        for message in messages:
            if message["role"] == "user":
                prompt += f"\n\nHuman: {message['content']}"
            elif message["role"] == "assistant":
                prompt += f"\n\nAssistant: {message['content']}"
        return prompt

    @backoff.on_exception(
        backoff.fibo,
        # https://platform.openai.com/docs/guides/error-codes/python-library-error-types
        (
            openai.error.Timeout,
            openai.error.RateLimitError,
            openai.error.ServiceUnavailableError,
            openai.error.APIConnectionError,
        ),
    )
    def call_lm(self, messages):
        if self.config.get("add_system_message", False):
            messages = self.add_system_message(messages)
            assert messages[0]["role"] == "system"
            # system msg will be formatted by vllm and fastchat, so no need to format here
        else:
            messages = [
                {"role": "system", "content": ""}
            ] + messages  # add empty system message

        try:
            if self.config["chat_mode"]:
                response = openai.ChatCompletion.create(
                    model=self.config["model_name"],
                    messages=messages,
                    max_tokens=self.config.get("max_tokens", 512),
                    temperature=self.config.get("temperature", 0),
                    stop=self.stop_words,
                    api_base=self.api_base,
                    api_key=self.api_key,
                )
                resp_str = response.choices[0].message["content"]

            else:
                prompt = self.format_prompt(messages)
                response = openai.Completion.create(
                    model=self.config["model_name"],
                    prompt=prompt,
                    max_tokens=self.config.get("max_tokens", 512),
                    temperature=self.config.get("temperature", 0),
                    stop=self.stop_words + ["\nExpert feedback:"],
                    api_base=self.api_base,
                    api_key=self.api_key,
                )
                resp_str = response.choices[0].text

        except openai.error.APIError as e:
            # This is special handling for FastChat Library
            # and is actually unrelated to the OpenAI API
            error_message = e.args[0]
            # Invalid response object from API: '{"object":"error","message":"This model\'s maximum context length is 4096 tokens. However, you requested 4169 tokens (3657 in the messages, 512 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error","param":null,"code":null}' (HTTP response code was 400))
            if "maximum context length" in error_message:
                raise openai.error.InvalidRequestError(e.args[0], "")
            else:
                raise e
        resp_str = resp_str.rstrip()  # remove trailing spaces (usually caused by llama)
        return resp_str, response["usage"]
