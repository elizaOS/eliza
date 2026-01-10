"""
Services for the elizaOS Bootstrap Plugin.

This module exports all available services for the bootstrap plugin.
"""

from .embedding import EmbeddingService
from .task import TaskService

__all__ = [
    "EmbeddingService",
    "TaskService",
    # Capability lists
    "BASIC_SERVICES",
    "EXTENDED_SERVICES",
    "ALL_SERVICES",
]

# Basic services - included by default
BASIC_SERVICES = [
    TaskService,
    EmbeddingService,
]

# Extended services - opt-in (none currently)
EXTENDED_SERVICES: list[type] = []

# All services list for easy registration (backwards compatibility)
ALL_SERVICES = BASIC_SERVICES + EXTENDED_SERVICES

