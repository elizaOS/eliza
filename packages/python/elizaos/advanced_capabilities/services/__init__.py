"""Advanced Services - Extended services for agent operation.

Services that can be enabled with `advanced_capabilities=True`.
"""

from .follow_up import FollowUpService
from .rolodex import RolodexService

__all__ = [
    "FollowUpService",
    "RolodexService",
    "advanced_services",
]

advanced_services: list[type] = [
    RolodexService,
    FollowUpService,
]
