import os
import logging
import traceback
import backoff
from typing import List, Mapping
import google.api_core.exceptions
import google.generativeai as palm
from google.generativeai.types import ChatResponse
from google.api_core.exceptions import InvalidArgument
from .base import LMAgent
from mint.datatypes import Action

palm.configure(api_key=os.environ.get("BARD_API_KEY", None))

LOGGER = logging.getLogger("MINT")


class BardIssue(Exception):
    pass


class BardLMAgent(LMAgent):
    def __init__(self, config):
        super().__init__(config)
        assert "model_name" in config.keys()
        self.stop_words = ["\nObservation:", "\nExpert feedback:", "\nTask:", "\n---"]
        if not self.config["model_name"].startswith("models/"):
            self.config["model_name"] = f"models/{self.config['model_name']}"

    def parse_bard_messages(self, messages: List[Mapping[str, str]]):
        # Bard accepts messages as a list of strings
        if self.config.get("add_system_message", False):
            messages = self.add_system_message(messages)
            assert messages[0]["role"] == "system"
            system = messages[0]["content"]
            messages = messages[1:]
            messages = [
                {"author": m["role"], "content": m["content"]} for m in messages
            ]
            return {
                "context": system,
                "examples": None,
                "messages": messages,
            }
        else:
            messages = [
                {"author": m["role"], "content": m["content"]} for m in messages
            ]
            return {
                "context": None,
                "examples": None,
                "messages": messages,
            }

    @backoff.on_exception(
        backoff.expo,
        (
            google.api_core.exceptions.GatewayTimeout,
            google.api_core.exceptions.ServiceUnavailable,
            google.api_core.exceptions.InternalServerError,
            google.api_core.exceptions.TooManyRequests,
        ),
    )
    def call_lm(self, messages: List[str]):
        parsed_prompt = self.parse_bard_messages(messages)
        token_stats = palm.count_message_tokens(
            context=parsed_prompt["context"],
            examples=parsed_prompt["examples"],
            messages=parsed_prompt["messages"],
        )

        # Prepend the prompt with the system message
        try:
            candidate_count = self.config.get("candidate_count", 1)
            response: ChatResponse = palm.chat(
                model=self.config["model_name"],
                context=parsed_prompt["context"],
                examples=parsed_prompt["examples"],
                messages=parsed_prompt["messages"],
                temperature=self.config.get("temperature", 0.0),
                candidate_count=candidate_count,
            )

            response_str = response.last
            # Best effort to find the candidate that contains <execute> or <solution>
            if candidate_count > 1:
                for candidate in response.candidates:
                    cur_content = candidate["content"]
                    if "<execute>" in cur_content or "<solution>" in cur_content:
                        response_str = cur_content
        except IndexError:
            raise BardIssue(
                f"IndexError (Likely triggered a filter). {traceback.format_exc()}"
            )
        except InvalidArgument:
            raise BardIssue(
                f"InvalidArgument (Likely exceeded maxlen). {traceback.format_exc()}"
            )
        if hasattr(response, "filters") and len(response.filters) > 0:
            raise BardIssue(
                f"Filters triggered: {response.filters}. {traceback.format_exc()}"
            )
        if (
            (not hasattr(response, "candidates"))
            or (response.candidates is None)
            or (len(response.candidates) == 0)
        ):
            raise BardIssue(f"Empty candidates: {response}")
        # cut off based on self.stop_words
        for stop_word in self.stop_words:
            if stop_word in response_str:
                response_str = response_str[: response_str.index(stop_word)].rstrip()
        LOGGER.info(token_stats)
        return response_str, token_stats

    def act(self, state):
        messages = state.history
        try:
            lm_output, token_usage = self.call_lm(messages)
            for usage_type, count in token_usage.items():
                state.token_counter[usage_type] += count
            action = self.lm_output_to_action(lm_output)
            return action
        except BardIssue as e:
            LOGGER.error(f"BardIssue\n{e.args[0]}")
            return Action(None, False, error=f"BardIssue\n{e.args[0]}")
