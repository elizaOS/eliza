# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
import getpass
from typing import TYPE_CHECKING

from ...doc_utils import export_module
from ...events.agent_events import InputRequestEvent
from ...events.base_event import BaseEvent

if TYPE_CHECKING:
    from ..run_response import AsyncRunResponseProtocol, RunResponseProtocol
    from .base import AsyncEventProcessorProtocol, EventProcessorProtocol


@export_module("autogen.io")
class ConsoleEventProcessor:
    def process(self, response: "RunResponseProtocol") -> None:
        for event in response.events:
            self.process_event(event)

    def process_event(self, event: BaseEvent) -> None:
        if isinstance(event, InputRequestEvent):
            prompt = event.content.prompt  # type: ignore[attr-defined]
            if event.content.password:  # type: ignore[attr-defined]
                result = getpass.getpass(prompt if prompt != "" else "Password: ")
            result = input(prompt)
            event.content.respond(result)  # type: ignore[attr-defined]
        else:
            event.print()


@export_module("autogen.io")
class AsyncConsoleEventProcessor:
    async def process(self, response: "AsyncRunResponseProtocol") -> None:
        async for event in response.events:
            await self.process_event(event)

    async def process_event(self, event: BaseEvent) -> None:
        if isinstance(event, InputRequestEvent):
            prompt = event.content.prompt  # type: ignore[attr-defined]
            if event.content.password:  # type: ignore[attr-defined]
                result = getpass.getpass(prompt if prompt != "" else "Password: ")
            result = input(prompt)
            await event.content.respond(result)  # type: ignore[attr-defined]
        else:
            event.print()


if TYPE_CHECKING:

    def check_type_1(x: ConsoleEventProcessor) -> EventProcessorProtocol:
        return x

    def check_type_2(x: AsyncConsoleEventProcessor) -> AsyncEventProcessorProtocol:
        return x
