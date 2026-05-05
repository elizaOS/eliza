# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
from typing import TYPE_CHECKING, Protocol

from ...doc_utils import export_module

if TYPE_CHECKING:
    from ..run_response import AsyncRunResponseProtocol, RunResponseProtocol

__all__ = ["AsyncEventProcessorProtocol", "EventProcessorProtocol"]


@export_module("autogen.io")
class EventProcessorProtocol(Protocol):
    def process(self, response: "RunResponseProtocol") -> None: ...


@export_module("autogen.io")
class AsyncEventProcessorProtocol(Protocol):
    async def process(self, response: "AsyncRunResponseProtocol") -> None: ...
