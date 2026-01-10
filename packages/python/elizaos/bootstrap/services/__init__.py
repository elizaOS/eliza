"""
Services for the elizaOS Bootstrap Plugin.

This module exports all available services for the bootstrap plugin.
"""

from .embedding import EmbeddingService
from .follow_up import FollowUpService
from .rolodex import RolodexService
from .task import TaskService

__all__ = [
    "EmbeddingService",
    "FollowUpService",
    "RolodexService",
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

# Extended services - opt-in (rolodex and follow-up)
EXTENDED_SERVICES: list[type] = [
    RolodexService,
    FollowUpService,
]

# All services list for easy registration (backwards compatibility)
ALL_SERVICES = BASIC_SERVICES + EXTENDED_SERVICES

