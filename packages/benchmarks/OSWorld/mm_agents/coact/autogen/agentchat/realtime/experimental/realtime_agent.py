# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass
from logging import Logger, getLogger
from typing import Any, Callable, Optional, TypeVar, Union

from anyio import lowlevel
from asyncer import create_task_group

from ....doc_utils import export_module
from ....llm_config import LLMConfig
from ....tools import Tool
from .clients.realtime_client import RealtimeClientProtocol, get_client
from .function_observer import FunctionObserver
from .realtime_observer import RealtimeObserver

F = TypeVar("F", bound=Callable[..., Any])

global_logger = getLogger(__name__)


@dataclass
class RealtimeAgentCallbacks:
    """Callbacks for the Realtime Agent."""

    # async empty placeholder function
    on_observers_ready: Callable[[], Any] = lambda: lowlevel.checkpoint()


@export_module("autogen.agentchat.realtime.experimental")
class RealtimeAgent:
    def __init__(
        self,
        *,
        name: str,
        audio_adapter: Optional[RealtimeObserver] = None,
        system_message: str = "You are a helpful AI Assistant.",
        llm_config: Optional[Union[LLMConfig, dict[str, Any]]] = None,
        logger: Optional[Logger] = None,
        observers: Optional[list[RealtimeObserver]] = None,
        **client_kwargs: Any,
    ):
        """(Experimental) Agent for interacting with the Realtime Clients.

        Args:
            name (str): The name of the agent.
            audio_adapter (Optional[RealtimeObserver] = None): The audio adapter for the agent.
            system_message (str): The system message for the agent.
            llm_config (LLMConfig, dict[str, Any], bool): The config for the agent.
            logger (Optional[Logger]): The logger for the agent.
            observers (Optional[list[RealtimeObserver]]): The additional observers for the agent.
            **client_kwargs (Any): The keyword arguments for the client.
        """
        self._logger = logger
        self._name = name
        self._system_message = system_message

        llm_config = LLMConfig.get_current_llm_config(llm_config)

        self._realtime_client: RealtimeClientProtocol = get_client(
            llm_config=llm_config, logger=self.logger, **client_kwargs
        )

        self._registered_realtime_tools: dict[str, Tool] = {}
        self._observers: list[RealtimeObserver] = observers if observers else []
        self._observers.append(FunctionObserver(logger=logger))
        if audio_adapter:
            self._observers.append(audio_adapter)

        self.callbacks = RealtimeAgentCallbacks()

    @property
    def system_message(self) -> str:
        """Get the system message for the agent."""
        return self._system_message

    @property
    def logger(self) -> Logger:
        """Get the logger for the agent."""
        return self._logger or global_logger

    @property
    def realtime_client(self) -> RealtimeClientProtocol:
        """Get the OpenAI Realtime Client."""
        return self._realtime_client

    @property
    def registered_realtime_tools(self) -> dict[str, Tool]:
        """Get the registered realtime tools."""
        return self._registered_realtime_tools

    def register_observer(self, observer: RealtimeObserver) -> None:
        """Register an observer with the Realtime Agent.

        Args:
            observer (RealtimeObserver): The observer to register.
        """
        self._observers.append(observer)

    async def start_observers(self) -> None:
        for observer in self._observers:
            self._tg.soonify(observer.run)(self)

        # wait for the observers to be ready
        for observer in self._observers:
            await observer.wait_for_ready()

        await self.callbacks.on_observers_ready()

    async def run(self) -> None:
        """Run the agent."""
        # everything is run in the same task group to enable easy cancellation using self._tg.cancel_scope.cancel()
        async with create_task_group() as self._tg:  # noqa: SIM117
            # connect with the client first (establishes a connection and initializes a session)
            async with self._realtime_client.connect():
                # start the observers and wait for them to be ready
                await self.realtime_client.session_update(session_options={"instructions": self.system_message})
                await self.start_observers()

                # iterate over the events
                async for event in self.realtime_client.read_events():
                    for observer in self._observers:
                        await observer.on_event(event)

    def register_realtime_function(
        self,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Callable[[Union[F, Tool]], Tool]:
        """Decorator for registering a function to be used by an agent.

        Args:
            name (str): The name of the function.
            description (str): The description of the function.

        Returns:
            Callable[[Union[F, Tool]], Tool]: The decorator for registering a function.
        """

        def _decorator(func_or_tool: Union[F, Tool]) -> Tool:
            """Decorator for registering a function to be used by an agent.

            Args:
                func_or_tool (Union[F, Tool]): The function or tool to register.

            Returns:
                Tool: The registered tool.
            """
            tool = Tool(func_or_tool=func_or_tool, name=name, description=description)

            self._registered_realtime_tools[tool.name] = tool

            return tool

        return _decorator
