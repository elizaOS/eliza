import json
import os

from pydantic import BaseModel, Field


# API domains
FEISHU_DOMAIN = "https://open.feishu.cn"
LARK_DOMAIN = "https://open.larksuite.com"


class FeishuConfig(BaseModel):
    """Configuration for the Feishu service."""

    app_id: str
    app_secret: str
    domain: str = Field(default="feishu")
    allowed_chats: list[str] = Field(default_factory=list)
    test_chat_id: str | None = None
    should_ignore_bot_messages: bool = True
    should_respond_only_to_mentions: bool = False

    @property
    def api_root(self) -> str:
        """Returns the API base URL for the configured domain."""
        if self.domain.lower() == "lark":
            return LARK_DOMAIN
        return FEISHU_DOMAIN

    @classmethod
    def from_env(cls) -> "FeishuConfig":
        """Load configuration from environment variables."""
        app_id = os.getenv("FEISHU_APP_ID")
        if not app_id:
            raise ValueError("FEISHU_APP_ID environment variable is required")

        app_secret = os.getenv("FEISHU_APP_SECRET")
        if not app_secret:
            raise ValueError("FEISHU_APP_SECRET environment variable is required")

        domain = os.getenv("FEISHU_DOMAIN", "feishu").lower()

        allowed_chats_str = os.getenv("FEISHU_ALLOWED_CHATS", "[]")
        try:
            allowed_chats = json.loads(allowed_chats_str)
            if not isinstance(allowed_chats, list):
                allowed_chats = []
        except json.JSONDecodeError:
            allowed_chats = []

        test_chat_id = os.getenv("FEISHU_TEST_CHAT_ID")

        should_ignore_bot_messages = os.getenv(
            "FEISHU_IGNORE_BOT_MESSAGES", "true"
        ).lower() != "false"

        should_respond_only_to_mentions = os.getenv(
            "FEISHU_RESPOND_ONLY_TO_MENTIONS", "false"
        ).lower() == "true"

        return cls(
            app_id=app_id,
            app_secret=app_secret,
            domain=domain,
            allowed_chats=allowed_chats,
            test_chat_id=test_chat_id,
            should_ignore_bot_messages=should_ignore_bot_messages,
            should_respond_only_to_mentions=should_respond_only_to_mentions,
        )

    def is_chat_allowed(self, chat_id: str) -> bool:
        """Check if a chat ID is allowed."""
        if not self.allowed_chats:
            return True
        return chat_id in self.allowed_chats

    def validate_config(self) -> tuple[bool, str | None]:
        """Validate the configuration."""
        if not self.app_id:
            return False, "App ID cannot be empty"

        if not self.app_id.startswith("cli_"):
            return False, "App ID should start with 'cli_'"

        if not self.app_secret:
            return False, "App secret cannot be empty"

        if self.domain not in ("feishu", "lark"):
            return False, "Domain must be 'feishu' or 'lark'"

        return True, None
