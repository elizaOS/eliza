from .embedding import EmbeddingService
from .follow_up import FollowUpService
from .rolodex import RolodexService
from .task import TaskService

__all__ = [
    "EmbeddingService",
    "FollowUpService",
    "RolodexService",
    "TaskService",
    "BASIC_SERVICES",
    "EXTENDED_SERVICES",
    "ALL_SERVICES",
]

BASIC_SERVICES = [
    TaskService,
    EmbeddingService,
]

EXTENDED_SERVICES: list[type] = [
    RolodexService,
    FollowUpService,
]

ALL_SERVICES = BASIC_SERVICES + EXTENDED_SERVICES
