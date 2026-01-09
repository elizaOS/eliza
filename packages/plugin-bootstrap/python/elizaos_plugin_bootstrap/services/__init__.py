"""
Services for the elizaOS Bootstrap Plugin.

This module exports all available services for the bootstrap plugin.
"""

from .embedding import EmbeddingService
from .task import TaskService

__all__ = [
    "EmbeddingService",
    "TaskService",
]

# All services list for easy registration
ALL_SERVICES = [
    EmbeddingService,
    TaskService,
]

