# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import logging
import warnings
from collections import defaultdict
from typing import TYPE_CHECKING, Any, Callable, Optional, TypeVar, Union

import anyio
from asyncer import asyncify, create_task_group, syncify

from ....agentchat.contrib.swarm_agent import AfterWorkOption, initiate_swarm_chat
from ....cache import AbstractCache
from ....code_utils import content_str
from ....doc_utils import export_module
from ... import Agent, ChatResult, ConversableAgent, LLMAgent
from ...utils import consolidate_chat_info, gather_usage_summary

if TYPE_CHECKING:
    from .clients import Role
    from .realtime_agent import RealtimeAgent

__all__ = ["register_swarm"]

SWARM_SYSTEM_MESSAGE = (
    "You are a helpful voice assistant. Your task is to listen to user and to coordinate the tasks based on his/her inputs."
    "You can and will communicate using audio output only."
)

QUESTION_ROLE: "Role" = "user"
QUESTION_MESSAGE = (
    "I have a question/information for myself. DO NOT ANSWER YOURSELF, GET THE ANSWER FROM ME. "
    "repeat the question to me **WITH AUDIO OUTPUT** and AFTER YOU GET THE ANSWER FROM ME call 'answer_task_question' with the answer in first person\n\n"
    "IMPORTANT: repeat just the question, without any additional information or context\n\n"
    "The question is: '{}'\n\n"
)
QUESTION_TIMEOUT_SECONDS = 20

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


def message_to_dict(message: Union[dict[str, Any], str]) -> dict[str, Any]:
    if isinstance(message, str):
        return {"content": message}
    elif isinstance(message, dict):
        return message
    else:
        return dict(message)


def parse_oai_message(message: Union[dict[str, Any], str], role: str, adressee: Agent) -> dict[str, Any]:
    """
    Parse a message into an OpenAI-compatible message format.

    Args:
        message: The message to parse.
        role: The role associated with the message.
        adressee: The agent that will receive the message.

    Returns:
        The parsed message in OpenAI-compatible format.

    Raises:
        ValueError: If the message lacks required fields like 'content', 'function_call', or 'tool_calls'.
    """
    message = message_to_dict(message)

    # Extract relevant fields while ensuring none are None
    oai_message = {
        key: message[key]
        for key in ("content", "function_call", "tool_calls", "tool_responses", "tool_call_id", "name", "context")
        if key in message and message[key] is not None
    }

    # Validate or set the content field
    if "content" not in oai_message:
        if "function_call" in oai_message or "tool_calls" in oai_message:
            oai_message["content"] = None
        else:
            raise ValueError("Message must have either 'content', 'function_call', or 'tool_calls' field.")

    # Determine and assign the role
    if message.get("role") in ["function", "tool"]:
        oai_message["role"] = message["role"]
        # Ensure all tool responses have string content
        for tool_response in oai_message.get("tool_responses", []):
            tool_response["content"] = str(tool_response["content"])
    elif "override_role" in message:
        oai_message["role"] = message["override_role"]
    else:
        oai_message["role"] = role

    # Enforce specific role requirements for assistant messages
    if oai_message.get("function_call") or oai_message.get("tool_calls"):
        oai_message["role"] = "assistant"

    # Add a name field if missing
    if "name" not in oai_message:
        oai_message["name"] = adressee.name

    return oai_message


class SwarmableAgent(Agent):
    """A class for an agent that can participate in a swarm chat."""

    def __init__(
        self,
        name: str,
        system_message: str = "You are a helpful AI Assistant.",
        is_termination_msg: Optional[Callable[..., bool]] = None,
        description: Optional[str] = None,
        silent: Optional[bool] = None,
    ):
        self._oai_messages: dict[Agent, Any] = defaultdict(list)

        self._system_message = system_message
        self._description = description if description is not None else system_message
        self._is_termination_msg = (
            is_termination_msg
            if is_termination_msg is not None
            else (lambda x: content_str(x.get("content")) == "TERMINATE")
        )
        self.silent = silent

        self._name = name

        # Initialize standalone client cache object.
        self.client_cache = None
        self.previous_cache = None

        self.reply_at_receive: dict[Agent, bool] = defaultdict(bool)

    @property
    def system_message(self) -> str:
        return self._system_message

    def update_system_message(self, system_message: str) -> None:
        """Update this agent's system message.

        Args:
            system_message (str): system message for inference.
        """
        self._system_message = system_message

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    def send(
        self,
        message: Union[dict[str, Any], str],
        recipient: Agent,
        request_reply: Optional[bool] = None,
        silent: Optional[bool] = False,
    ) -> None:
        self._oai_messages[recipient].append(parse_oai_message(message, "assistant", recipient))
        recipient.receive(message, self, request_reply)

    def receive(
        self,
        message: Union[dict[str, Any], str],
        sender: Agent,
        request_reply: Optional[bool] = None,
        silent: Optional[bool] = False,
    ) -> None:
        self._oai_messages[sender].append(parse_oai_message(message, "user", self))
        if request_reply is False or (request_reply is None and self.reply_at_receive[sender] is False):
            return
        reply = self.generate_reply(messages=self.chat_messages[sender], sender=sender)
        if reply is not None:
            self.send(reply, sender, silent=silent)

    def generate_reply(
        self,
        messages: Optional[list[dict[str, Any]]] = None,
        sender: Optional["Agent"] = None,
        **kwargs: Any,
    ) -> Union[str, dict[str, Any], None]:
        if messages is None:
            if sender is None:
                raise ValueError("Either messages or sender must be provided.")
            messages = self._oai_messages[sender]

        _, reply = self.check_termination_and_human_reply(messages=messages, sender=sender, config=None)

        return reply

    def check_termination_and_human_reply(
        self,
        messages: Optional[list[dict[str, Any]]] = None,
        sender: Optional[Agent] = None,
        config: Optional[Any] = None,
    ) -> tuple[bool, Union[str, None]]:
        raise NotImplementedError

    def initiate_chat(
        self,
        recipient: ConversableAgent,
        message: Union[dict[str, Any], str],
        clear_history: bool = True,
        silent: Optional[bool] = False,
        cache: Optional[AbstractCache] = None,
        summary_args: Optional[dict[str, Any]] = {},
        **kwargs: dict[str, Any],
    ) -> ChatResult:
        _chat_info = locals().copy()
        _chat_info["sender"] = self
        consolidate_chat_info(_chat_info, uniform_sender=self)
        recipient._raise_exception_on_async_reply_functions()
        recipient.previous_cache = recipient.client_cache  # type: ignore[attr-defined]
        recipient.client_cache = cache  # type: ignore[attr-defined, assignment]

        self._prepare_chat(recipient, clear_history)
        self.send(message, recipient, silent=silent)
        summary = self._last_msg_as_summary(self, recipient, summary_args)

        recipient.client_cache = recipient.previous_cache  # type: ignore[attr-defined]
        recipient.previous_cache = None  # type: ignore[attr-defined]

        chat_result = ChatResult(
            chat_history=self.chat_messages[recipient],
            summary=summary,
            cost=gather_usage_summary([self, recipient]),  # type: ignore[arg-type]
            human_input=[],
        )
        return chat_result

    async def a_generate_reply(
        self,
        messages: Optional[list[dict[str, Any]]] = None,
        sender: Optional["Agent"] = None,
        **kwargs: Any,
    ) -> Union[str, dict[str, Any], None]:
        return self.generate_reply(messages=messages, sender=sender, **kwargs)

    async def a_receive(
        self,
        message: Union[dict[str, Any], str],
        sender: "Agent",
        request_reply: Optional[bool] = None,
    ) -> None:
        self.receive(message, sender, request_reply)

    async def a_send(
        self,
        message: Union[dict[str, Any], str],
        recipient: "Agent",
        request_reply: Optional[bool] = None,
    ) -> None:
        self.send(message, recipient, request_reply)

    @property
    def chat_messages(self) -> dict[Agent, list[dict[str, Any]]]:
        """A dictionary of conversations from agent to list of messages."""
        return self._oai_messages

    def last_message(self, agent: Optional[Agent] = None) -> Optional[dict[str, Any]]:
        if agent is None:
            n_conversations = len(self._oai_messages)
            if n_conversations == 0:
                return None
            if n_conversations == 1:
                for conversation in self._oai_messages.values():
                    return conversation[-1]  # type: ignore[no-any-return]
            raise ValueError("More than one conversation is found. Please specify the sender to get the last message.")
        if agent not in self._oai_messages():
            raise KeyError(
                f"The agent '{agent.name}' is not present in any conversation. No history available for this agent."
            )
        return self._oai_messages[agent][-1]  # type: ignore[no-any-return]

    def _prepare_chat(
        self,
        recipient: ConversableAgent,
        clear_history: bool,
        prepare_recipient: bool = True,
        reply_at_receive: bool = True,
    ) -> None:
        self.reply_at_receive[recipient] = reply_at_receive
        if clear_history:
            self._oai_messages[recipient].clear()
        if prepare_recipient:
            recipient._prepare_chat(self, clear_history, False, reply_at_receive)  # type: ignore[arg-type]

    def _raise_exception_on_async_reply_functions(self) -> None:
        pass

    def set_ui_tools(self, tools: Optional[list] = None) -> None:
        """Set UI tools for the agent."""
        pass

    def unset_ui_tools(self) -> None:
        """Unset UI tools for the agent."""
        pass

    @staticmethod
    def _last_msg_as_summary(sender: Agent, recipient: Agent, summary_args: Optional[dict[str, Any]]) -> str:
        """Get a chat summary from the last message of the recipient."""
        summary = ""
        try:
            content = recipient.last_message(sender)["content"]  # type: ignore[attr-defined]
            if isinstance(content, str):
                summary = content.replace("TERMINATE", "")
            elif isinstance(content, list):
                summary = "\n".join(
                    x["text"].replace("TERMINATE", "") for x in content if isinstance(x, dict) and "text" in x
                )
        except (IndexError, AttributeError) as e:
            warnings.warn(f"Cannot extract summary using last_msg: {e}. Using an empty str as summary.", UserWarning)
        return summary


# check that the SwarmableAgent class is implementing LLMAgent protocol
if TYPE_CHECKING:

    def _create_swarmable_agent(
        name: str,
        system_message: str,
        is_termination_msg: Optional[Callable[..., bool]],
        description: Optional[str],
        silent: Optional[bool],
    ) -> LLMAgent:
        return SwarmableAgent(
            name=name,
            system_message=system_message,
            is_termination_msg=is_termination_msg,
            description=description,
            silent=silent,
        )


class SwarmableRealtimeAgent(SwarmableAgent):
    def __init__(
        self,
        realtime_agent: "RealtimeAgent",
        initial_agent: ConversableAgent,
        agents: list[ConversableAgent],
        question_message: Optional[str] = None,
    ) -> None:
        self._initial_agent = initial_agent
        self._agents = agents
        self._realtime_agent = realtime_agent

        self._answer_event: anyio.Event = anyio.Event()
        self._answer: str = ""
        self.question_message = question_message or QUESTION_MESSAGE

        super().__init__(
            name=realtime_agent._name,
            is_termination_msg=None,
            description=None,
            silent=None,
        )

    def reset_answer(self) -> None:
        """Reset the answer event."""
        self._answer_event = anyio.Event()

    def set_answer(self, answer: str) -> str:
        """Set the answer to the question."""
        self._answer = answer
        self._answer_event.set()
        return "Answer set successfully."

    async def get_answer(self) -> str:
        """Get the answer to the question."""
        await self._answer_event.wait()
        return self._answer

    async def ask_question(self, question: str, question_timeout: int) -> None:
        """Send a question for the user to the agent and wait for the answer.
        If the answer is not received within the timeout, the question is repeated.

        Args:
            question: The question to ask the user.
            question_timeout: The time in seconds to wait for the answer.
        """
        self.reset_answer()
        realtime_client = self._realtime_agent._realtime_client
        await realtime_client.send_text(role=QUESTION_ROLE, text=question)

        async def _check_event_set(timeout: int = question_timeout) -> bool:
            for _ in range(timeout):
                if self._answer_event.is_set():
                    return True
                await anyio.sleep(1)
            return False

        while not await _check_event_set():
            await realtime_client.send_text(role=QUESTION_ROLE, text=question)

    def check_termination_and_human_reply(
        self,
        messages: Optional[list[dict[str, Any]]] = None,
        sender: Optional[Agent] = None,
        config: Optional[Any] = None,
    ) -> tuple[bool, Optional[str]]:
        """Check if the conversation should be terminated and if the agent should reply.

        Called when its agents turn in the chat conversation.

        Args:
            messages (list[dict[str, Any]]): The messages in the conversation.
            sender (Agent): The agent that sent the message.
            config (Optional[Any]): The configuration for the agent.
        """
        if not messages:
            return False, None

        async def get_input() -> None:
            async with create_task_group() as tg:
                tg.soonify(self.ask_question)(
                    self.question_message.format(messages[-1]["content"]),
                    question_timeout=QUESTION_TIMEOUT_SECONDS,
                )

        syncify(get_input)()

        return True, {"role": "user", "content": self._answer}  # type: ignore[return-value]

    def start_chat(self) -> None:
        raise NotImplementedError

    def configure_realtime_agent(self, system_message: Optional[str]) -> None:
        realtime_agent = self._realtime_agent

        logger = realtime_agent.logger
        if not system_message:
            if realtime_agent.system_message != "You are a helpful AI Assistant.":
                logger.warning(
                    "Overriding system message set up in `__init__`, please use `system_message` parameter of the `register_swarm` function instead."
                )
            system_message = SWARM_SYSTEM_MESSAGE

        realtime_agent._system_message = system_message

        realtime_agent.register_realtime_function(
            name="answer_task_question", description="Answer question from the task"
        )(self.set_answer)

        async def on_observers_ready() -> None:
            self._realtime_agent._tg.soonify(asyncify(initiate_swarm_chat))(
                initial_agent=self._initial_agent,
                agents=self._agents,
                user_agent=self,  # type: ignore[arg-type]
                messages="Find out what the user wants.",
                after_work=AfterWorkOption.REVERT_TO_USER,
            )

        self._realtime_agent.callbacks.on_observers_ready = on_observers_ready


@export_module("autogen.agentchat.realtime.experimental")
def register_swarm(
    *,
    realtime_agent: "RealtimeAgent",
    initial_agent: ConversableAgent,
    agents: list[ConversableAgent],
    system_message: Optional[str] = None,
    question_message: Optional[str] = None,
) -> None:
    """Create a SwarmableRealtimeAgent.

    Args:
        realtime_agent (RealtimeAgent): The RealtimeAgent to create the SwarmableRealtimeAgent from.
        initial_agent (ConversableAgent): The initial agent.
        agents (list[ConversableAgent]): The agents in the swarm.
        system_message (Optional[str]): The system message to set for the agent. If None, the default system message is used.
        question_message (Optional[str]): The question message to set for the agent. If None, the default QUESTION_MESSAGE is used.
    """
    swarmable_agent = SwarmableRealtimeAgent(
        realtime_agent=realtime_agent, initial_agent=initial_agent, agents=agents, question_message=question_message
    )

    swarmable_agent.configure_realtime_agent(system_message=system_message)
