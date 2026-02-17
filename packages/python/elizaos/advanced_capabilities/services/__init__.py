"""Advanced Services - Extended services for agent operation.

Services that can be enabled with `advanced_capabilities=True`.
"""

__all__ = [
    "advanced_services",
]

# Rolodex/follow-up services are owned by plugin-rolodex.
advanced_services: list[type] = []
