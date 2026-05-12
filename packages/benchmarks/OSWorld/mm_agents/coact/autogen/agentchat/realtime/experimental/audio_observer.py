# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Optional

from ....doc_utils import export_module
from .realtime_events import InputAudioBufferDelta, RealtimeEvent
from .realtime_observer import RealtimeObserver

if TYPE_CHECKING:
    from logging import Logger


@export_module("autogen.agentchat.realtime.experimental")
class AudioObserver(RealtimeObserver):
    """Observer for user voice input"""

    def __init__(self, *, logger: Optional["Logger"] = None) -> None:
        """Observer for user voice input"""
        super().__init__(logger=logger)

    async def on_event(self, event: RealtimeEvent) -> None:
        """Observe voice input events from the Realtime.

        Args:
            event (dict[str, Any]): The event from the OpenAI Realtime API.
        """
        if isinstance(event, InputAudioBufferDelta):
            self.logger.info("Received audio buffer delta")

    async def initialize_session(self) -> None:
        """No need to initialize session from this observer"""
        pass

    async def run_loop(self) -> None:
        """Run the observer loop."""
        pass


if TYPE_CHECKING:
    function_observer: RealtimeObserver = AudioObserver()
