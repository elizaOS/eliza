"""Trust providers."""

from .admin_trust import admin_trust_provider
from .roles import role_provider
from .security_status import security_status_provider
from .settings import settings_provider
from .trust_profile import trust_profile_provider

trust_providers = [
    trust_profile_provider,
    security_status_provider,
    admin_trust_provider,
    role_provider,
    settings_provider,
]

__all__ = [
    "trust_profile_provider",
    "security_status_provider",
    "admin_trust_provider",
    "role_provider",
    "settings_provider",
    "trust_providers",
]
