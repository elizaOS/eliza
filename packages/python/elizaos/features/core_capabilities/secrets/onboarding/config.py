"""Onboarding configuration types and utilities.

Provides the structure for defining secret requirements per agent/plugin,
supporting both conversational and form-based collection flows.

Ported from secrets/onboarding/config.ts.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..types import SecretType


@dataclass
class OnboardingSetting:
    """Setting definition for onboarding.

    Compatible with the-org OnboardingConfig format.
    """

    name: str
    """Display name."""
    description: str
    """Description for LLM context."""
    secret: bool
    """Whether this is a secret (should be encrypted)."""
    public: bool
    """Whether this should be visible in non-onboarding contexts."""
    required: bool
    """Whether this setting is required."""
    depends_on: list[str] = field(default_factory=list)
    """Settings that must be configured first."""
    usage_description: str | None = None
    """Prompt shown when asking user for this setting."""
    validation: Callable[[str], bool] | None = None
    """Validation function."""
    validation_method: str | None = None
    """Validation method name (openai, anthropic, url, etc.)."""
    type: SecretType | None = None
    """Secret type."""
    env_var: str | None = None
    """Environment variable to sync to."""
    default_value: str | None = None
    """Default value if not set."""
    value: str | None = None
    """Current value (set during onboarding)."""
    visible_if: Callable[[dict[str, OnboardingSetting]], bool] | None = None
    """Conditional visibility based on other settings."""
    on_set_action: Callable[[str | bool], str | None] | None = None
    """Callback when value is set."""


@dataclass
class OnboardingConfig:
    """Onboarding configuration for an agent or plugin."""

    settings: dict[str, OnboardingSetting] = field(default_factory=dict)
    """Setting definitions."""
    messages: dict[str, Any] | None = None
    """Optional platform-specific messages."""
    mode: str = "conversational"
    """Onboarding flow mode: conversational, form, or hybrid."""


DEFAULT_ONBOARDING_MESSAGES: dict[str, Any] = {
    "welcome": [
        "Hi! I need to collect some information to get set up. Is now a good time?",
        "Hey there! I need to configure a few things. Do you have a moment?",
        "Hello! Could we take a few minutes to get everything set up?",
    ],
    "askSetting": "I need your {{settingName}}. {{usageDescription}}",
    "settingUpdated": "Got it! I've saved your {{settingName}}.",
    "allComplete": "Great! All required settings have been configured. You're all set!",
    "error": "I had trouble understanding that. Could you try again?",
}


COMMON_API_KEY_SETTINGS: dict[str, dict[str, Any]] = {
    "OPENAI_API_KEY": {
        "name": "OpenAI API Key",
        "description": "API key for OpenAI services (GPT models)",
        "usage_description": 'Your OpenAI API key starts with "sk-"',
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": [],
        "validation_method": "openai",
        "type": SecretType.API_KEY,
        "env_var": "OPENAI_API_KEY",
    },
    "ANTHROPIC_API_KEY": {
        "name": "Anthropic API Key",
        "description": "API key for Anthropic services (Claude models)",
        "usage_description": 'Your Anthropic API key starts with "sk-ant-"',
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": [],
        "validation_method": "anthropic",
        "type": SecretType.API_KEY,
        "env_var": "ANTHROPIC_API_KEY",
    },
    "GROQ_API_KEY": {
        "name": "Groq API Key",
        "description": "API key for Groq inference services",
        "usage_description": 'Your Groq API key starts with "gsk_"',
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": [],
        "validation_method": "groq",
        "type": SecretType.API_KEY,
        "env_var": "GROQ_API_KEY",
    },
    "GOOGLE_API_KEY": {
        "name": "Google API Key",
        "description": "API key for Google AI services (Gemini)",
        "usage_description": "Your Google API key for Gemini models",
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": [],
        "validation_method": "google",
        "type": SecretType.API_KEY,
        "env_var": "GOOGLE_API_KEY",
    },
    "DISCORD_BOT_TOKEN": {
        "name": "Discord Bot Token",
        "description": "Bot token for Discord integration",
        "usage_description": "Your Discord bot token from the developer portal",
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": [],
        "validation_method": "discord",
        "type": SecretType.TOKEN,
        "env_var": "DISCORD_BOT_TOKEN",
    },
    "TELEGRAM_BOT_TOKEN": {
        "name": "Telegram Bot Token",
        "description": "Bot token for Telegram integration",
        "usage_description": "Your Telegram bot token from @BotFather",
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": [],
        "validation_method": "telegram",
        "type": SecretType.TOKEN,
        "env_var": "TELEGRAM_BOT_TOKEN",
    },
    "TWITTER_USERNAME": {
        "name": "Twitter Username",
        "description": "Twitter/X username for posting",
        "usage_description": "The Twitter username (without @)",
        "secret": False,
        "public": True,
        "required": False,
        "depends_on": [],
        "type": SecretType.CREDENTIAL,
    },
    "TWITTER_PASSWORD": {
        "name": "Twitter Password",
        "description": "Twitter/X account password",
        "usage_description": "The password for your Twitter account",
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": ["TWITTER_USERNAME"],
        "type": SecretType.CREDENTIAL,
    },
    "TWITTER_EMAIL": {
        "name": "Twitter Email",
        "description": "Email associated with Twitter account",
        "usage_description": "The email address linked to your Twitter account",
        "secret": False,
        "public": False,
        "required": False,
        "depends_on": ["TWITTER_USERNAME"],
        "type": SecretType.CREDENTIAL,
    },
    "TWITTER_2FA_SECRET": {
        "name": "Twitter 2FA Secret",
        "description": "2FA secret for Twitter account",
        "usage_description": "The 2FA/TOTP secret (if 2FA is enabled)",
        "secret": True,
        "public": False,
        "required": False,
        "depends_on": ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
        "type": SecretType.CREDENTIAL,
    },
}


def create_onboarding_config(
    required_keys: list[str],
    optional_keys: list[str] | None = None,
    custom_settings: dict[str, dict[str, Any]] | None = None,
) -> OnboardingConfig:
    """Create an onboarding config from a list of required secret keys."""
    optional_keys = optional_keys or []
    custom_settings = custom_settings or {}
    settings: dict[str, OnboardingSetting] = {}

    for key in required_keys:
        common = COMMON_API_KEY_SETTINGS.get(key, {})
        custom = custom_settings.get(key, {})
        merged = {**common, **custom}
        settings[key] = OnboardingSetting(
            name=merged.get("name", key),
            description=merged.get("description", f"Configure {key}"),
            usage_description=merged.get("usage_description"),
            secret=merged.get("secret", True),
            public=merged.get("public", False),
            required=True,
            depends_on=merged.get("depends_on", []),
            validation_method=merged.get("validation_method"),
            type=merged.get("type", SecretType.API_KEY),
            env_var=merged.get("env_var", key),
            value=None,
        )

    for key in optional_keys:
        common = COMMON_API_KEY_SETTINGS.get(key, {})
        custom = custom_settings.get(key, {})
        merged = {**common, **custom}
        settings[key] = OnboardingSetting(
            name=merged.get("name", key),
            description=merged.get("description", f"Configure {key}"),
            usage_description=merged.get("usage_description"),
            secret=merged.get("secret", True),
            public=merged.get("public", False),
            required=False,
            depends_on=merged.get("depends_on", []),
            validation_method=merged.get("validation_method"),
            type=merged.get("type", SecretType.API_KEY),
            env_var=merged.get("env_var", key),
            value=None,
        )

    return OnboardingConfig(settings=settings)


def get_unconfigured_required(
    config: OnboardingConfig,
) -> list[tuple[str, OnboardingSetting]]:
    """Get unconfigured required settings from an onboarding config."""
    return [
        (key, setting)
        for key, setting in config.settings.items()
        if setting.required and setting.value is None
    ]


def get_unconfigured_optional(
    config: OnboardingConfig,
) -> list[tuple[str, OnboardingSetting]]:
    """Get unconfigured optional settings from an onboarding config."""
    return [
        (key, setting)
        for key, setting in config.settings.items()
        if not setting.required and setting.value is None
    ]


def is_onboarding_complete(config: OnboardingConfig) -> bool:
    """Check if all required settings are configured."""
    return len(get_unconfigured_required(config)) == 0


def get_next_setting(
    config: OnboardingConfig,
) -> tuple[str, OnboardingSetting] | None:
    """Get the next setting to configure (respects dependencies)."""
    unconfigured = get_unconfigured_required(config)

    for key, setting in unconfigured:
        dependencies_met = all(
            config.settings.get(dep) is not None and config.settings[dep].value is not None
            for dep in setting.depends_on
        )
        is_visible = setting.visible_if is None or setting.visible_if(config.settings)
        if dependencies_met and is_visible:
            return (key, setting)

    # If no required settings, try optional
    optional_unconfigured = get_unconfigured_optional(config)
    for key, setting in optional_unconfigured:
        dependencies_met = all(
            config.settings.get(dep) is not None and config.settings[dep].value is not None
            for dep in setting.depends_on
        )
        is_visible = setting.visible_if is None or setting.visible_if(config.settings)
        if dependencies_met and is_visible:
            return (key, setting)

    return None


def generate_setting_prompt(
    key: str,
    setting: OnboardingSetting,
    agent_name: str,
) -> str:
    """Generate a prompt for the LLM to ask for a specific setting."""
    required = "(Required)" if setting.required else "(Optional)"
    usage = setting.usage_description or setting.description
    return (
        f"{agent_name} needs to collect the {setting.name} {required}.\n"
        f"Description: {usage}\n"
        f"Ask the user for their {setting.name} in a natural, conversational way."
    )
