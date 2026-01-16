"""Basic Services - Essential services for agent operation.

Core services included by default in the bootstrap plugin.
"""

from .embedding import EmbeddingService
from .task import TaskService

__all__ = [
    "EmbeddingService",
    "TaskService",
    "basic_services",
]

basic_services: list[type] = [
    TaskService,
    EmbeddingService,
]
