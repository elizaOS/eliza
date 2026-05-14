from .openai_lm_agent import OpenAILMAgent
import openai
import openai.error
import logging
import traceback
from mint.datatypes import Action
import backoff

LOGGER = logging.getLogger("MINT")
# REMEMBER to RUN ALL MODELS


class VLLMAgent(OpenAILMAgent):
    """Inference for open-sourced models with a unified interface with OpenAI's API."""

    def __init__(self, config):
        super().__init__(config)
        assert (
            "openai.api_base" in config.keys()
        ), "missing openai.api_base to connect to server"
        self.api_base = config["openai.api_base"]
        self.api_key = "EMPTY"
        LOGGER.info("remember to openup the server using docs/SERVING.mdh")
        self.stop_words = [
            "\nObservation:",
            "\nExpert feedback:",
            "\nTask:",
            "\n---",
            "\nHuman:",
        ]

    def format_prompt(self, messages):
        """Format messages into a prompt for the model."""
        prompt = ""
        for message in messages:
            if message["role"] == "user":
                prompt += f"\n\nHuman: {message['content']}"
            elif message["role"] == "assistant":
                prompt += f"\n\nAssistant: {message['content']}"
        prompt += "\n\nAssistant:"
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
            # simply ignore chat messages as it may cause issue for some served models
            pass

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
                    stop=self.stop_words,
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
