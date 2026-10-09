# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT

import queue
from asyncio import Queue as AsyncQueue
from typing import Any, AsyncIterable, Dict, Iterable, Optional, Protocol, Sequence, Union
from uuid import UUID, uuid4

from pydantic import BaseModel, Field

from autogen.tools.tool import Tool

from ..agentchat.agent import Agent, LLMMessageType
from ..agentchat.group.context_variables import ContextVariables
from ..events.agent_events import ErrorEvent, InputRequestEvent, RunCompletionEvent
from ..events.base_event import BaseEvent
from .processors import (
    AsyncConsoleEventProcessor,
    AsyncEventProcessorProtocol,
    ConsoleEventProcessor,
    EventProcessorProtocol,
)
from .thread_io_stream import AsyncThreadIOStream, ThreadIOStream

Message = dict[str, Any]


class RunInfoProtocol(Protocol):
    @property
    def uuid(self) -> UUID: ...

    @property
    def above_run(self) -> Optional["RunResponseProtocol"]: ...


class Usage(BaseModel):
    cost: float
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class CostBreakdown(BaseModel):
    total_cost: float
    models: Dict[str, Usage] = Field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> "CostBreakdown":
        # Extract total cost
        total_cost = data.get("total_cost", 0.0)

        # Remove total_cost key to extract models
        model_usages = {k: Usage(**v) for k, v in data.items() if k != "total_cost"}

        return cls(total_cost=total_cost, models=model_usages)


class Cost(BaseModel):
    usage_including_cached_inference: CostBreakdown
    usage_excluding_cached_inference: CostBreakdown

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> "Cost":
        return cls(
            usage_including_cached_inference=CostBreakdown.from_raw(data.get("usage_including_cached_inference", {})),
            usage_excluding_cached_inference=CostBreakdown.from_raw(data.get("usage_excluding_cached_inference", {})),
        )


class RunResponseProtocol(RunInfoProtocol, Protocol):
    @property
    def events(self) -> Iterable[BaseEvent]: ...

    @property
    def messages(self) -> Iterable[Message]: ...

    @property
    def summary(self) -> Optional[str]: ...

    @property
    def context_variables(self) -> Optional[ContextVariables]: ...

    @property
    def last_speaker(self) -> Optional[str]: ...

    @property
    def cost(self) -> Optional[Cost]: ...

    def process(self, processor: Optional[EventProcessorProtocol] = None) -> None: ...

    def set_ui_tools(self, tools: list[Tool]) -> None: ...


class AsyncRunResponseProtocol(RunInfoProtocol, Protocol):
    @property
    def events(self) -> AsyncIterable[BaseEvent]: ...

    @property
    async def messages(self) -> Iterable[Message]: ...

    @property
    async def summary(self) -> Optional[str]: ...

    @property
    async def context_variables(self) -> Optional[ContextVariables]: ...

    @property
    async def last_speaker(self) -> Optional[str]: ...

    @property
    async def cost(self) -> Optional[Cost]: ...

    async def process(self, processor: Optional[AsyncEventProcessorProtocol] = None) -> None: ...

    def set_ui_tools(self, tools: list[Tool]) -> None: ...


class RunResponse:
    def __init__(self, iostream: ThreadIOStream, agents: list[Agent]):
        self.iostream = iostream
        self.agents = agents
        self._summary: Optional[str] = None
        self._messages: Sequence[LLMMessageType] = []
        self._uuid = uuid4()
        self._context_variables: Optional[ContextVariables] = None
        self._last_speaker: Optional[str] = None
        self._cost: Optional[Cost] = None

    def _queue_generator(self, q: queue.Queue) -> Iterable[BaseEvent]:  # type: ignore[type-arg]
        """A generator to yield items from the queue until the termination message is found."""
        while True:
            try:
                # Get an item from the queue
                event = q.get(timeout=0.1)  # Adjust timeout as needed

                if isinstance(event, InputRequestEvent):
                    event.content.respond = lambda response: self.iostream._output_stream.put(response)  # type: ignore[attr-defined]

                yield event

                if isinstance(event, RunCompletionEvent):
                    self._messages = event.content.history  # type: ignore[attr-defined]
                    self._last_speaker = event.content.last_speaker  # type: ignore[attr-defined]
                    self._summary = event.content.summary  # type: ignore[attr-defined]
                    self._context_variables = event.content.context_variables  # type: ignore[attr-defined]
                    self.cost = event.content.cost  # type: ignore[attr-defined]
                    break

                if isinstance(event, ErrorEvent):
                    raise event.content.error  # type: ignore[attr-defined]
            except queue.Empty:
                continue  # Wait for more items in the queue

    @property
    def events(self) -> Iterable[BaseEvent]:
        return self._queue_generator(self.iostream.input_stream)

    @property
    def messages(self) -> Iterable[Message]:
        return self._messages

    @property
    def summary(self) -> Optional[str]:
        return self._summary

    @property
    def above_run(self) -> Optional["RunResponseProtocol"]:
        return None

    @property
    def uuid(self) -> UUID:
        return self._uuid

    @property
    def context_variables(self) -> Optional[ContextVariables]:
        return self._context_variables

    @property
    def last_speaker(self) -> Optional[str]:
        return self._last_speaker

    @property
    def cost(self) -> Optional[Cost]:
        return self._cost

    @cost.setter
    def cost(self, value: Union[Cost, dict[str, Any]]) -> None:
        if isinstance(value, dict):
            self._cost = Cost.from_raw(value)
        else:
            self._cost = value

    def process(self, processor: Optional[EventProcessorProtocol] = None) -> None:
        processor = processor or ConsoleEventProcessor()
        processor.process(self)

    def set_ui_tools(self, tools: list[Tool]) -> None:
        """Set the UI tools for the agents."""
        for agent in self.agents:
            agent.set_ui_tools(tools)


class AsyncRunResponse:
    def __init__(self, iostream: AsyncThreadIOStream, agents: list[Agent]):
        self.iostream = iostream
        self.agents = agents
        self._summary: Optional[str] = None
        self._messages: Sequence[LLMMessageType] = []
        self._uuid = uuid4()
        self._context_variables: Optional[ContextVariables] = None
        self._last_speaker: Optional[str] = None
        self._cost: Optional[Cost] = None

    async def _queue_generator(self, q: AsyncQueue[Any]) -> AsyncIterable[BaseEvent]:  # type: ignore[type-arg]
        """A generator to yield items from the queue until the termination message is found."""
        while True:
            try:
                # Get an item from the queue
                event = await q.get()

                if isinstance(event, InputRequestEvent):

                    async def respond(response: str) -> None:
                        await self.iostream._output_stream.put(response)

                    event.content.respond = respond  # type: ignore[attr-defined]

                yield event

                if isinstance(event, RunCompletionEvent):
                    self._messages = event.content.history  # type: ignore[attr-defined]
                    self._last_speaker = event.content.last_speaker  # type: ignore[attr-defined]
                    self._summary = event.content.summary  # type: ignore[attr-defined]
                    self._context_variables = event.content.context_variables  # type: ignore[attr-defined]
                    self.cost = event.content.cost  # type: ignore[attr-defined]
                    break

                if isinstance(event, ErrorEvent):
                    raise event.content.error  # type: ignore[attr-defined]
            except queue.Empty:
                continue

    @property
    def events(self) -> AsyncIterable[BaseEvent]:
        return self._queue_generator(self.iostream.input_stream)

    @property
    async def messages(self) -> Iterable[Message]:
        return self._messages

    @property
    async def summary(self) -> Optional[str]:
        return self._summary

    @property
    def above_run(self) -> Optional["RunResponseProtocol"]:
        return None

    @property
    def uuid(self) -> UUID:
        return self._uuid

    @property
    async def context_variables(self) -> Optional[ContextVariables]:
        return self._context_variables

    @property
    async def last_speaker(self) -> Optional[str]:
        return self._last_speaker

    @property
    async def cost(self) -> Optional[Cost]:
        return self._cost

    @cost.setter
    def cost(self, value: Union[Cost, dict[str, Any]]) -> None:
        if isinstance(value, dict):
            self._cost = Cost.from_raw(value)
        else:
            self._cost = value

    async def process(self, processor: Optional[AsyncEventProcessorProtocol] = None) -> None:
        processor = processor or AsyncConsoleEventProcessor()
        await processor.process(self)

    def set_ui_tools(self, tools: list[Tool]) -> None:
        """Set the UI tools for the agents."""
        for agent in self.agents:
            agent.set_ui_tools(tools)
