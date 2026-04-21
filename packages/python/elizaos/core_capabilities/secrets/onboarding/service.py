"""Onboarding Service.

Manages the secrets onboarding flow across platforms (Discord, Telegram, etc.)
Supports both conversational and form-based collection modes.

Ported from secrets/onboarding/service.ts.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar

from elizaos.types import Service

from ..types import SecretContext, SecretLevel
from .config import (
    DEFAULT_ONBOARDING_MESSAGES,
    OnboardingConfig,
    OnboardingSetting,
    get_next_setting,
    get_unconfigured_required,
    is_onboarding_complete,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory

    from ..service import SecretsService

logger = logging.getLogger(__name__)

ONBOARDING_SERVICE_TYPE = "SECRETS_ONBOARDING"


@dataclass
class OnboardingSession:
    """Onboarding session state."""

    world_id: str
    user_id: str
    room_id: str
    config: OnboardingConfig
    current_setting_key: str | None = None
    started_at: float = field(default_factory=time.time)
    last_activity_at: float = field(default_factory=time.time)
    platform: str = "other"
    mode: str = "conversational"


class OnboardingService(Service):
    """Onboarding Service for secrets collection.

    Manages sessions for collecting required secrets from users
    across different chat platforms.
    """

    service_type: ClassVar[str] = ONBOARDING_SERVICE_TYPE
    capability_description: str = "Manage secrets onboarding across chat platforms"

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        super().__init__(runtime)
        self._secrets_service: SecretsService | None = None
        self._sessions: dict[str, OnboardingSession] = {}

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> OnboardingService:
        """Start the service."""
        service = cls(runtime)
        await service._initialize()
        return service

    async def _initialize(self) -> None:
        logger.info("[OnboardingService] Starting")
        if self.runtime is not None:
            for svc in (self.runtime.services or {}).values():
                if getattr(svc, "service_type", None) == "secrets":
                    self._secrets_service = svc  # type: ignore[assignment]
                    break
        logger.info("[OnboardingService] Started")

    async def stop(self) -> None:
        logger.info("[OnboardingService] Stopping")
        self._sessions.clear()
        logger.info("[OnboardingService] Stopped")

    # ------------------------------------------------------------------
    # Onboarding initialization
    # ------------------------------------------------------------------

    async def initialize_onboarding(
        self,
        world: Any,
        config: OnboardingConfig,
    ) -> None:
        """Initialize onboarding for a world with the given config."""
        logger.info("[OnboardingService] Initializing onboarding for world: %s", world.id)

        if not hasattr(world, "metadata") or world.metadata is None:
            world.metadata = {}

        settings_state: dict[str, OnboardingSetting] = {}
        for key, setting in config.settings.items():
            settings_state[key] = OnboardingSetting(
                name=setting.name,
                description=setting.description,
                usage_description=setting.usage_description,
                secret=setting.secret,
                public=setting.public,
                required=setting.required,
                depends_on=list(setting.depends_on),
                validation=setting.validation,
                validation_method=setting.validation_method,
                type=setting.type,
                env_var=setting.env_var,
                value=None,
            )

        world.metadata["settings"] = settings_state
        world.metadata["onboardingConfig"] = config

        if self.runtime is not None:
            await self.runtime.update_world(world)
        logger.info("[OnboardingService] Onboarding initialized for world: %s", world.id)

    # ------------------------------------------------------------------
    # Discord / Telegram start helpers
    # ------------------------------------------------------------------

    async def start_discord_onboarding_dm(
        self,
        server_id: str,
        owner_id: str,
        world_id: str,
        config: OnboardingConfig,
    ) -> None:
        """Start onboarding via DM (Discord)."""
        messages = (config.messages or {}).get("welcome", DEFAULT_ONBOARDING_MESSAGES["welcome"])
        _random_message = messages[random.randint(0, len(messages) - 1)]  # noqa: S311

        logger.info(
            "[OnboardingService] Discord DM onboarding started - server: %s, owner: %s, world: %s",
            server_id,
            owner_id,
            world_id,
        )

    async def start_telegram_onboarding(
        self,
        world: Any,
        chat: dict[str, Any],
        entities: list[dict[str, Any]],
        bot_username: str,
    ) -> None:
        """Start onboarding via deep link (Telegram)."""
        owner_id: str | None = None
        owner_username: str | None = None

        for entity in entities:
            tg = (entity.get("metadata") or {}).get("telegram") or {}
            if tg.get("adminTitle") == "Owner":
                owner_id = tg.get("id")
                owner_username = tg.get("username")
                break

        if not owner_id:
            logger.warning("[OnboardingService] No owner found for Telegram group")
            return

        if self.runtime is not None:
            telegram_service = None
            for svc in (self.runtime.services or {}).values():
                if getattr(svc, "service_type", None) == "telegram":
                    telegram_service = svc
                    break

            if telegram_service and hasattr(telegram_service, "message_manager"):
                deep_link_message = (
                    f"Hello @{owner_username}! Could we take a few minutes to get everything set up? "
                    f"Please click this link to start chatting with me: "
                    f"https://t.me/{bot_username}?start=onboarding"
                )
                await telegram_service.message_manager.send_message(
                    chat.get("id"), {"text": deep_link_message}
                )
                logger.info(
                    "[OnboardingService] Sent Telegram deep link - chatId: %s, ownerId: %s",
                    chat.get("id"),
                    owner_id,
                )

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    async def start_session(
        self,
        world_id: str,
        user_id: str,
        room_id: str,
        config: OnboardingConfig,
        platform: str = "other",
        mode: str = "conversational",
    ) -> OnboardingSession:
        """Start a new onboarding session."""
        session = OnboardingSession(
            world_id=world_id,
            user_id=user_id,
            room_id=room_id,
            config=config,
            platform=platform,
            mode=mode,
        )
        self._sessions[room_id] = session
        logger.info(
            "[OnboardingService] Session started - roomId: %s, worldId: %s, userId: %s",
            room_id,
            world_id,
            user_id,
        )
        return session

    def get_session(self, room_id: str) -> OnboardingSession | None:
        """Get an active session by room ID."""
        return self._sessions.get(room_id)

    async def process_message(
        self,
        room_id: str,
        message: Memory,
    ) -> dict[str, Any]:
        """Process a user message during onboarding.

        Returns dict with keys: should_respond, response, updated_key, complete.
        """
        session = self._sessions.get(room_id)
        if not session:
            return {"should_respond": False}

        session.last_activity_at = time.time()

        unconfigured = get_unconfigured_required(session.config)

        if not unconfigured:
            return {
                "should_respond": True,
                "response": (session.config.messages or {}).get(
                    "allComplete", DEFAULT_ONBOARDING_MESSAGES["allComplete"]
                ),
                "complete": True,
            }

        text = (message.content.text if message.content else "") or ""
        current_setting = (
            session.config.settings.get(session.current_setting_key)
            if session.current_setting_key
            else None
        )

        if current_setting and text.strip():
            value = text.strip()
            current_key = session.current_setting_key
            if not current_key:
                return {
                    "should_respond": True,
                    "response": "I lost track of which setting I was collecting. Let's try that again.",
                }

            # Validate
            if current_setting.validation and not current_setting.validation(value):
                return {
                    "should_respond": True,
                    "response": (
                        f"That doesn't look like a valid {current_setting.name}. "
                        f"{current_setting.usage_description or 'Please try again.'}"
                    ),
                }

            # Store the value
            if self._secrets_service is not None:
                context = SecretContext(
                    level=SecretLevel.WORLD,
                    agent_id=str(self.runtime.agent_id) if self.runtime else "",
                    world_id=session.world_id,
                    user_id=session.user_id,
                )
                await self._secrets_service.set(current_key, value, context)

            # Update local state
            session.config.settings[current_key].value = value

            # Check if complete
            if is_onboarding_complete(session.config):
                self._sessions.pop(room_id, None)
                return {
                    "should_respond": True,
                    "response": (session.config.messages or {}).get(
                        "allComplete", DEFAULT_ONBOARDING_MESSAGES["allComplete"]
                    ),
                    "updated_key": current_key,
                    "complete": True,
                }

            # Get next setting
            next_pair = get_next_setting(session.config)
            if next_pair:
                next_key, next_setting = next_pair
                session.current_setting_key = next_key
                ask_msg = (
                    (session.config.messages or {})
                    .get("askSetting", DEFAULT_ONBOARDING_MESSAGES["askSetting"])
                    .replace("{{settingName}}", next_setting.name)
                    .replace(
                        "{{usageDescription}}",
                        next_setting.usage_description or next_setting.description,
                    )
                )
                updated_msg = (
                    (session.config.messages or {})
                    .get("settingUpdated", DEFAULT_ONBOARDING_MESSAGES["settingUpdated"])
                    .replace("{{settingName}}", current_setting.name)
                )
                return {
                    "should_respond": True,
                    "response": f"{updated_msg}\n\n{ask_msg}",
                    "updated_key": current_key,
                }

        # Start asking for the first/next setting
        next_pair = get_next_setting(session.config)
        if next_pair:
            next_key, next_setting = next_pair
            session.current_setting_key = next_key
            ask_msg = (
                (session.config.messages or {})
                .get("askSetting", DEFAULT_ONBOARDING_MESSAGES["askSetting"])
                .replace("{{settingName}}", next_setting.name)
                .replace(
                    "{{usageDescription}}",
                    next_setting.usage_description or next_setting.description,
                )
            )
            return {"should_respond": True, "response": ask_msg}

        return {"should_respond": False}

    def end_session(self, room_id: str) -> None:
        """End an onboarding session."""
        self._sessions.pop(room_id, None)
        logger.info("[OnboardingService] Session ended - roomId: %s", room_id)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    async def get_onboarding_status(self, world_id: str) -> dict[str, Any]:
        """Get the onboarding status for a world."""
        if self.runtime is None:
            return {
                "initialized": False,
                "complete": False,
                "configured_count": 0,
                "required_count": 0,
                "missing_required": [],
            }

        world = await self.runtime.get_world(world_id)
        if not world or not getattr(world, "metadata", None):
            return {
                "initialized": False,
                "complete": False,
                "configured_count": 0,
                "required_count": 0,
                "missing_required": [],
            }

        metadata: dict[str, Any] = world.metadata if isinstance(world.metadata, dict) else {}
        raw_settings = metadata.get("settings")
        if not isinstance(raw_settings, dict):
            return {
                "initialized": False,
                "complete": False,
                "configured_count": 0,
                "required_count": 0,
                "missing_required": [],
            }

        settings: dict[str, OnboardingSetting] = {
            key: value
            for key, value in raw_settings.items()
            if isinstance(key, str) and isinstance(value, OnboardingSetting)
        }
        if not settings:
            return {
                "initialized": False,
                "complete": False,
                "configured_count": 0,
                "required_count": 0,
                "missing_required": [],
            }

        required = [(k, s) for k, s in settings.items() if s.required]
        configured = [(k, s) for k, s in required if s.value is not None]
        missing = [k for k, s in required if s.value is None]

        return {
            "initialized": True,
            "complete": len(missing) == 0,
            "configured_count": len(configured),
            "required_count": len(required),
            "missing_required": missing,
        }

    # ------------------------------------------------------------------
    # LLM context generation
    # ------------------------------------------------------------------

    def generate_settings_context(
        self,
        config: OnboardingConfig,
        is_onboarding: bool,
        agent_name: str,
    ) -> str:
        """Generate the SETTINGS provider context for the LLM."""
        entries = list(config.settings.items())
        unconfigured = get_unconfigured_required(config)

        settings_list_parts = []
        for key, setting in entries:
            required = "(Required)" if setting.required else "(Optional)"
            if setting.secret and setting.value:
                value = "****************"
            else:
                value = setting.value or "Not set"
            usage = setting.usage_description or setting.description
            settings_list_parts.append(f"{key}: {value} {required}\n({setting.name}) {usage}")

        settings_list = "\n\n".join(settings_list_parts)
        valid_keys = "Valid setting keys: " + ", ".join(k for k, _ in entries)

        if is_onboarding and unconfigured:
            return (
                f"# PRIORITY TASK: Onboarding\n\n"
                f"{agent_name} needs to help the user configure {len(unconfigured)} required settings:\n\n"
                f"{settings_list}\n\n"
                f"{valid_keys}\n\n"
                f"Instructions for {agent_name}:\n"
                f"- Only update settings if the user is clearly responding to a setting you are currently asking about.\n"
                f"- If the user's reply clearly maps to a setting and a valid value, you **must** call the UPDATE_SETTINGS action.\n"
                f"- Never hallucinate settings or respond with values not listed above.\n"
                f"- Prioritize configuring required settings before optional ones."
            )

        important = ""
        if unconfigured:
            important = (
                f"IMPORTANT: {len(unconfigured)} required settings still need configuration.\n\n"
            )
        else:
            important = "All required settings are configured.\n\n"

        return f"## Current Configuration\n{important}{settings_list}"
