import pytest

from elizaos_plugin_gmail_watch import GmailWatchConfig, ServeConfig


@pytest.fixture
def mock_config() -> GmailWatchConfig:
    """Provides a minimal valid Gmail Watch configuration."""
    return GmailWatchConfig(
        account="user@gmail.com",
        label="INBOX",
        topic="projects/my-project/topics/gog-gmail-watch",
        hook_url="http://127.0.0.1:18789/hooks/gmail",
        hook_token="shared-secret",
        include_body=True,
        max_bytes=20000,
        renew_every_minutes=360,
        serve=ServeConfig(bind="127.0.0.1", port=8788, path="/gmail-pubsub"),
    )


@pytest.fixture
def full_settings() -> dict[str, object]:
    """Provides a full character settings dict matching the TS config shape."""
    return {
        "hooks": {
            "enabled": True,
            "token": "shared-secret",
            "presets": ["gmail"],
            "gmail": {
                "account": "user@gmail.com",
                "label": "INBOX",
                "topic": "projects/my-project/topics/gog-gmail-watch",
                "pushToken": "my-push-token",
                "hookUrl": "http://127.0.0.1:18789/hooks/gmail",
                "includeBody": True,
                "maxBytes": 20000,
                "renewEveryMinutes": 360,
                "serve": {
                    "bind": "127.0.0.1",
                    "port": 8788,
                    "path": "/gmail-pubsub",
                },
            },
        }
    }
