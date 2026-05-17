import logging
from typing import List, Dict, Any, Mapping

LOGGER = logging.getLogger("MINT")

from mint.datatypes import Action, State


class LMAgent:
    """Base class for an agent."""

    def __init__(self, config: Mapping[str, Any]):
        self.config = config
        LOGGER.info(f"Initialized {self.__class__.__name__} with config: {config}")
        # The agent should not generate observations or expert feedback
        self.stop_words = ["\nObservation:", "\nExpert feedback:", "\nTask:", "\n---"]

    def lm_output_to_action(self, lm_output: str) -> Action:
        propose_solution = bool("<solution>" in lm_output)
        return Action(lm_output, not propose_solution)

    def act(self, state: State) -> Action:
        """
        The history should be a format like:
        [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Who won the world series in 2020?"},
            {"role": "assistant", "content": "The Los Angeles Dodgers won the World Series in 2020."},
            {"role": "user", "content": "Where was it played?"}
        ]
        """
        raise NotImplementedError

    def add_system_message(
        self, messages: List[Dict[str, str]]
    ) -> List[Dict[str, str]]:
        # Prepend the prompt with the system message
        first_msg = messages[0]
        assert first_msg["role"] == "user"
        system, examples, task = first_msg["content"].split("\n---\n")
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": examples + "\n---\n" + task},
        ] + messages[1:]
        return messages
