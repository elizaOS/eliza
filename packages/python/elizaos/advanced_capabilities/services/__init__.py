"""Advanced Services - Extended services for agent operation.

Services that can be enabled with `advanced_capabilities=True`.
"""

from .follow_up import FollowUpService
from .relationships import RelationshipsService

__all__ = [
    "FollowUpService",
    "RelationshipsService",
    "advanced_services",
]

advanced_services: list[type] = [
    RelationshipsService,
    FollowUpService,
]
