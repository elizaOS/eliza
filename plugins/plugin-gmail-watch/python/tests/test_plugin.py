"""Tests for the plugin module and public API."""

from elizaos_plugin_gmail_watch import (
    PLUGIN_DESCRIPTION,
    PLUGIN_NAME,
    ConfigError,
    GmailWatchConfig,
    GmailWatchError,
    GmailWatchService,
    GogBinaryNotFoundError,
    ProcessError,
    RenewalError,
    ServeConfig,
    __version__,
)


class TestPluginMetadata:
    def test_plugin_name(self) -> None:
        assert PLUGIN_NAME == "gmail-watch"

    def test_plugin_description(self) -> None:
        assert "Gmail" in PLUGIN_DESCRIPTION
        assert len(PLUGIN_DESCRIPTION) > 0

    def test_plugin_version(self) -> None:
        assert __version__ == "2.0.0"


class TestPublicExports:
    def test_config_is_importable(self) -> None:
        assert GmailWatchConfig is not None

    def test_serve_config_is_importable(self) -> None:
        assert ServeConfig is not None

    def test_service_is_importable(self) -> None:
        assert GmailWatchService is not None


class TestErrorHierarchy:
    def test_base_error(self) -> None:
        err = GmailWatchError("test error")
        assert str(err) == "test error"
        assert err.cause is None

    def test_base_error_with_cause(self) -> None:
        cause = ValueError("root cause")
        err = GmailWatchError("wrapped", cause=cause)
        assert err.cause is cause

    def test_config_error_is_gmail_watch_error(self) -> None:
        err = ConfigError("bad config")
        assert isinstance(err, GmailWatchError)

    def test_gog_not_found_error(self) -> None:
        err = GogBinaryNotFoundError()
        assert isinstance(err, GmailWatchError)
        assert "gog" in str(err).lower()

    def test_process_error(self) -> None:
        err = ProcessError("crashed", exit_code=1)
        assert isinstance(err, GmailWatchError)
        assert err.exit_code == 1

    def test_renewal_error(self) -> None:
        err = RenewalError("failed", exit_code=2)
        assert isinstance(err, GmailWatchError)
        assert err.exit_code == 2


class TestConfigDefaults:
    def test_serve_config_defaults(self) -> None:
        s = ServeConfig()
        assert s.bind == "127.0.0.1"
        assert s.port == 8788
        assert s.path == "/gmail-pubsub"

    def test_gmail_watch_config_defaults(self) -> None:
        config = GmailWatchConfig(account="a@b.com")
        assert config.label == "INBOX"
        assert config.topic == ""
        assert config.subscription is None
        assert config.push_token == ""
        assert config.hook_url == "http://127.0.0.1:18789/hooks/gmail"
        assert config.hook_token == ""
        assert config.include_body is True
        assert config.max_bytes == 20000
        assert config.renew_every_minutes == 360

    def test_service_creation(self) -> None:
        config = GmailWatchConfig(account="a@b.com")
        service = GmailWatchService(config)
        assert service.config.account == "a@b.com"
        assert service.is_running is False
        assert service.restart_attempts == 0
