"""Onboarding subsystem for secrets collection.

Manages secrets onboarding flows across platforms (Discord, Telegram, etc.)
with conversational and form-based collection modes.

Ported from secrets/onboarding/ TypeScript.
"""

from .action import update_settings_action
from .config import (
    COMMON_API_KEY_SETTINGS,
    DEFAULT_ONBOARDING_MESSAGES,
    OnboardingConfig,
    OnboardingSetting,
    create_onboarding_config,
    generate_setting_prompt,
    get_next_setting,
    get_unconfigured_optional,
    get_unconfigured_required,
    is_onboarding_complete,
)
from .provider import missing_secrets_provider, onboarding_settings_provider
from .service import ONBOARDING_SERVICE_TYPE, OnboardingService

__all__ = [
    # Service
    "OnboardingService",
    "ONBOARDING_SERVICE_TYPE",
    # Action
    "update_settings_action",
    # Providers
    "onboarding_settings_provider",
    "missing_secrets_provider",
    # Config
    "OnboardingConfig",
    "OnboardingSetting",
    "DEFAULT_ONBOARDING_MESSAGES",
    "COMMON_API_KEY_SETTINGS",
    "create_onboarding_config",
    "get_unconfigured_required",
    "get_unconfigured_optional",
    "is_onboarding_complete",
    "get_next_setting",
    "generate_setting_prompt",
]
