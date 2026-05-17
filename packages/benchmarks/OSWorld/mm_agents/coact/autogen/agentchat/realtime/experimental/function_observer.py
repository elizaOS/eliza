# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from typing import TYPE_CHECKING, Any, Optional

from asyncer import asyncify
from pydantic import BaseModel

from ....doc_utils import export_module
from .realtime_events import FunctionCall, RealtimeEvent
from .realtime_observer import RealtimeObserver

if TYPE_CHECKING:
    from logging import Logger


@export_module("autogen.agentchat.realtime.experimental")
class FunctionObserver(RealtimeObserver):
    """Observer for handling function calls from the OpenAI Realtime API."""

    def __init__(self, *, logger: Optional["Logger"] = None) -> None:
        """Observer for handling function calls from the OpenAI Realtime API."""
        super().__init__(logger=logger)

    async def on_event(self, event: RealtimeEvent) -> None:
        """Handle function call events from the OpenAI Realtime API.

        Args:
            event (dict[str, Any]): The event from the OpenAI Realtime API.
        """
        if isinstance(event, FunctionCall):
            self.logger.info("Received function call event")
            await self.call_function(
                call_id=event.call_id,
                name=event.name,
                kwargs=event.arguments,
            )

    async def call_function(self, call_id: str, name: str, kwargs: dict[str, Any]) -> None:
        """Call a function registered with the agent.

        Args:
            call_id (str): The ID of the function call.
            name (str): The name of the function to call.
            kwargs (Any[str, Any]): The arguments to pass to the function.
        """
        if name in self.agent.registered_realtime_tools:
            func = self.agent.registered_realtime_tools[name].func
            func = func if asyncio.iscoroutinefunction(func) else asyncify(func)
            try:
                result = await func(**kwargs)
            except Exception:
                result = "Function call failed"
                self.logger.info(f"Function call failed: {name=}, {kwargs=}", stack_info=True)

            if isinstance(result, BaseModel):
                result = result.model_dump_json()
            elif not isinstance(result, str):
                try:
                    result = json.dumps(result)
                except Exception:
                    result = str(result)

            await self.realtime_client.send_function_result(call_id, result)
        else:
            self.logger.warning(f"Function {name} called, but is not registered with the realtime agent.")

    async def initialize_session(self) -> None:
        """Add registered tools to OpenAI with a session update."""
        session_update = {
            "tools": [tool.realtime_tool_schema for tool in self.agent.registered_realtime_tools.values()],
            "tool_choice": "auto",
        }
        await self.realtime_client.session_update(session_update)

    async def run_loop(self) -> None:
        """Run the observer loop."""
        pass


if TYPE_CHECKING:
    function_observer: RealtimeObserver = FunctionObserver()
