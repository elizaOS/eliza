"""Configuration for the Gmail Watch plugin."""

from pydantic import BaseModel, Field

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 8788
DEFAULT_PATH = "/gmail-pubsub"
DEFAULT_RENEW_MINUTES = 360  # 6 hours
DEFAULT_MAX_BYTES = 20000
DEFAULT_HOOK_URL = "http://127.0.0.1:18789/hooks/gmail"


class ServeConfig(BaseModel):
    """Configuration for the local Pub/Sub push receiver."""

    bind: str = Field(default=DEFAULT_BIND)
    port: int = Field(default=DEFAULT_PORT)
    path: str = Field(default=DEFAULT_PATH)


class GmailWatchConfig(BaseModel):
    """Configuration for the Gmail Watch service.

    This is resolved from the character settings at ``hooks.gmail.*``.
    """

    account: str
    label: str = Field(default="INBOX")
    topic: str = Field(default="")
    subscription: str | None = None
    push_token: str = Field(default="")
    hook_url: str = Field(default=DEFAULT_HOOK_URL)
    hook_token: str = Field(default="")
    include_body: bool = Field(default=True)
    max_bytes: int = Field(default=DEFAULT_MAX_BYTES)
    renew_every_minutes: int = Field(default=DEFAULT_RENEW_MINUTES)
    serve: ServeConfig = Field(default_factory=ServeConfig)

    def validate_config(self) -> tuple[bool, str | None]:
        """Validate the configuration.

        Returns:
            A (valid, error_message) tuple.
        """
        if not self.account:
            return False, "Account cannot be empty"

        if not self.account.strip():
            return False, "Account cannot be blank"

        if self.renew_every_minutes <= 0:
            return False, "renew_every_minutes must be positive"

        if self.max_bytes < 0:
            return False, "max_bytes cannot be negative"

        if self.serve.port < 1 or self.serve.port > 65535:
            return False, "serve.port must be between 1 and 65535"

        return True, None

    @classmethod
    def from_settings(cls, settings: dict[str, object]) -> "GmailWatchConfig | None":
        """Resolve a :class:`GmailWatchConfig` from character settings.

        The expected layout mirrors the TypeScript implementation::

            settings.hooks.gmail.account   (required)
            settings.hooks.gmail.label     (optional, default "INBOX")
            ...

        Returns ``None`` when ``hooks.gmail.account`` is not configured.
        """
        hooks = settings.get("hooks")
        if not isinstance(hooks, dict):
            return None

        gmail = hooks.get("gmail")
        if not isinstance(gmail, dict):
            return None

        account_raw = gmail.get("account")
        account = str(account_raw).strip() if isinstance(account_raw, str) else ""
        if not account:
            return None

        hooks_token_raw = hooks.get("token")
        hooks_token = str(hooks_token_raw).strip() if isinstance(hooks_token_raw, str) else ""

        serve_raw = gmail.get("serve")
        serve_dict = serve_raw if isinstance(serve_raw, dict) else {}

        serve = ServeConfig(
            bind=str(serve_dict.get("bind", DEFAULT_BIND))
            if isinstance(serve_dict.get("bind"), str)
            else DEFAULT_BIND,
            port=int(serve_dict["port"])
            if isinstance(serve_dict.get("port"), (int, float))
            else DEFAULT_PORT,
            path=str(serve_dict.get("path", DEFAULT_PATH))
            if isinstance(serve_dict.get("path"), str)
            else DEFAULT_PATH,
        )

        return cls(
            account=account,
            label=str(gmail.get("label", "INBOX"))
            if isinstance(gmail.get("label"), str)
            else "INBOX",
            topic=str(gmail.get("topic", ""))
            if isinstance(gmail.get("topic"), str)
            else "",
            subscription=str(gmail["subscription"])
            if isinstance(gmail.get("subscription"), str)
            else None,
            push_token=str(gmail.get("pushToken", ""))
            if isinstance(gmail.get("pushToken"), str)
            else "",
            hook_url=str(gmail.get("hookUrl", DEFAULT_HOOK_URL))
            if isinstance(gmail.get("hookUrl"), str)
            else DEFAULT_HOOK_URL,
            hook_token=hooks_token,
            include_body=gmail.get("includeBody") is not False,
            max_bytes=int(gmail["maxBytes"])
            if isinstance(gmail.get("maxBytes"), (int, float))
            else DEFAULT_MAX_BYTES,
            renew_every_minutes=int(gmail["renewEveryMinutes"])
            if isinstance(gmail.get("renewEveryMinutes"), (int, float))
            else DEFAULT_RENEW_MINUTES,
            serve=serve,
        )
