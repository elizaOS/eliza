"""Tests for the GmailWatchService."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_gmail_watch import GmailWatchConfig, GmailWatchService, ServeConfig
from elizaos_plugin_gmail_watch.service import (
    INITIAL_RESTART_DELAY_S,
    MAX_RESTART_ATTEMPTS,
    MAX_RESTART_DELAY_S,
    build_renew_args,
    build_serve_args,
    calculate_backoff_delay,
    find_gog_binary,
)


# ---------------------------------------------------------------------------
# Backoff / delay calculation
# ---------------------------------------------------------------------------


class TestCalculateBackoffDelay:
    def test_first_attempt(self) -> None:
        """First attempt should use the initial delay."""
        assert calculate_backoff_delay(1) == INITIAL_RESTART_DELAY_S

    def test_second_attempt(self) -> None:
        """Second attempt should double the initial delay."""
        assert calculate_backoff_delay(2) == INITIAL_RESTART_DELAY_S * 2

    def test_third_attempt(self) -> None:
        """Third attempt should be 4x the initial delay."""
        assert calculate_backoff_delay(3) == INITIAL_RESTART_DELAY_S * 4

    def test_clamped_to_max(self) -> None:
        """Very high attempt numbers should clamp to the maximum delay."""
        delay = calculate_backoff_delay(50)
        assert delay == MAX_RESTART_DELAY_S

    def test_zero_attempt_uses_initial(self) -> None:
        """Edge case: attempt 0 should fall back to initial delay."""
        assert calculate_backoff_delay(0) == INITIAL_RESTART_DELAY_S

    def test_all_attempts_within_bounds(self) -> None:
        """Every attempt from 1..MAX should be within bounds."""
        for i in range(1, MAX_RESTART_ATTEMPTS + 1):
            delay = calculate_backoff_delay(i)
            assert INITIAL_RESTART_DELAY_S <= delay <= MAX_RESTART_DELAY_S

    def test_delays_are_monotonically_non_decreasing(self) -> None:
        """Backoff delays should never decrease as attempts increase."""
        prev = 0.0
        for i in range(1, 20):
            delay = calculate_backoff_delay(i)
            assert delay >= prev
            prev = delay


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


class TestConfigValidation:
    def test_valid_config(self, mock_config: GmailWatchConfig) -> None:
        valid, err = mock_config.validate_config()
        assert valid is True
        assert err is None

    def test_empty_account(self) -> None:
        config = GmailWatchConfig(account="")
        valid, err = config.validate_config()
        assert valid is False
        assert err is not None
        assert "empty" in err.lower()

    def test_blank_account(self) -> None:
        config = GmailWatchConfig(account="   ")
        valid, err = config.validate_config()
        assert valid is False
        assert err is not None

    def test_negative_renew_minutes(self) -> None:
        config = GmailWatchConfig(account="a@b.com", renew_every_minutes=-1)
        valid, err = config.validate_config()
        assert valid is False
        assert "positive" in (err or "").lower()

    def test_zero_renew_minutes(self) -> None:
        config = GmailWatchConfig(account="a@b.com", renew_every_minutes=0)
        valid, err = config.validate_config()
        assert valid is False

    def test_negative_max_bytes(self) -> None:
        config = GmailWatchConfig(account="a@b.com", max_bytes=-1)
        valid, err = config.validate_config()
        assert valid is False
        assert "negative" in (err or "").lower()

    def test_invalid_port_too_high(self) -> None:
        config = GmailWatchConfig(
            account="a@b.com",
            serve=ServeConfig(port=70000),
        )
        valid, err = config.validate_config()
        assert valid is False
        assert "port" in (err or "").lower()

    def test_invalid_port_zero(self) -> None:
        config = GmailWatchConfig(
            account="a@b.com",
            serve=ServeConfig(port=0),
        )
        valid, err = config.validate_config()
        assert valid is False


# ---------------------------------------------------------------------------
# Config from_settings
# ---------------------------------------------------------------------------


class TestConfigFromSettings:
    def test_full_settings(self, full_settings: dict[str, object]) -> None:
        config = GmailWatchConfig.from_settings(full_settings)
        assert config is not None
        assert config.account == "user@gmail.com"
        assert config.label == "INBOX"
        assert config.topic == "projects/my-project/topics/gog-gmail-watch"
        assert config.push_token == "my-push-token"
        assert config.hook_token == "shared-secret"
        assert config.include_body is True
        assert config.max_bytes == 20000
        assert config.renew_every_minutes == 360
        assert config.serve.bind == "127.0.0.1"
        assert config.serve.port == 8788
        assert config.serve.path == "/gmail-pubsub"

    def test_missing_hooks(self) -> None:
        assert GmailWatchConfig.from_settings({}) is None

    def test_missing_gmail_section(self) -> None:
        assert GmailWatchConfig.from_settings({"hooks": {}}) is None

    def test_missing_account(self) -> None:
        settings: dict[str, object] = {"hooks": {"gmail": {}}}
        assert GmailWatchConfig.from_settings(settings) is None

    def test_empty_account(self) -> None:
        settings: dict[str, object] = {"hooks": {"gmail": {"account": ""}}}
        assert GmailWatchConfig.from_settings(settings) is None

    def test_minimal_account(self) -> None:
        settings: dict[str, object] = {"hooks": {"gmail": {"account": "me@x.com"}}}
        config = GmailWatchConfig.from_settings(settings)
        assert config is not None
        assert config.account == "me@x.com"
        # Defaults should be applied
        assert config.label == "INBOX"
        assert config.renew_every_minutes == 360
        assert config.serve.port == 8788

    def test_include_body_explicit_false(self) -> None:
        settings: dict[str, object] = {
            "hooks": {"gmail": {"account": "a@b.com", "includeBody": False}}
        }
        config = GmailWatchConfig.from_settings(settings)
        assert config is not None
        assert config.include_body is False


# ---------------------------------------------------------------------------
# Build CLI arguments
# ---------------------------------------------------------------------------


class TestBuildServeArgs:
    def test_basic_args(self, mock_config: GmailWatchConfig) -> None:
        args = build_serve_args(mock_config)
        assert args[:3] == ["gmail", "watch", "serve"]
        assert "--account" in args
        assert "user@gmail.com" in args
        assert "--bind" in args
        assert "--port" in args
        assert "--path" in args
        assert "--hook-url" in args

    def test_includes_hook_token(self, mock_config: GmailWatchConfig) -> None:
        args = build_serve_args(mock_config)
        assert "--hook-token" in args
        idx = args.index("--hook-token")
        assert args[idx + 1] == "shared-secret"

    def test_include_body_flag(self, mock_config: GmailWatchConfig) -> None:
        args = build_serve_args(mock_config)
        assert "--include-body" in args

    def test_no_include_body(self) -> None:
        config = GmailWatchConfig(account="a@b.com", include_body=False)
        args = build_serve_args(config)
        assert "--include-body" not in args

    def test_no_hook_token(self) -> None:
        config = GmailWatchConfig(account="a@b.com", hook_token="")
        args = build_serve_args(config)
        assert "--hook-token" not in args

    def test_no_push_token(self) -> None:
        config = GmailWatchConfig(account="a@b.com", push_token="")
        args = build_serve_args(config)
        assert "--token" not in args

    def test_push_token_present(self) -> None:
        config = GmailWatchConfig(account="a@b.com", push_token="tok123")
        args = build_serve_args(config)
        assert "--token" in args
        idx = args.index("--token")
        assert args[idx + 1] == "tok123"


class TestBuildRenewArgs:
    def test_basic_renew_args(self, mock_config: GmailWatchConfig) -> None:
        args = build_renew_args(mock_config)
        assert args[:3] == ["gmail", "watch", "start"]
        assert "--account" in args
        assert "--label" in args

    def test_includes_topic(self, mock_config: GmailWatchConfig) -> None:
        args = build_renew_args(mock_config)
        assert "--topic" in args

    def test_no_topic(self) -> None:
        config = GmailWatchConfig(account="a@b.com", topic="")
        args = build_renew_args(config)
        assert "--topic" not in args


# ---------------------------------------------------------------------------
# find_gog_binary
# ---------------------------------------------------------------------------


class TestFindGogBinary:
    def test_found(self) -> None:
        with patch("elizaos_plugin_gmail_watch.service.shutil.which", return_value="/usr/bin/gog"):
            assert find_gog_binary() == "/usr/bin/gog"

    def test_not_found(self) -> None:
        with patch("elizaos_plugin_gmail_watch.service.shutil.which", return_value=None):
            assert find_gog_binary() is None


# ---------------------------------------------------------------------------
# Service lifecycle
# ---------------------------------------------------------------------------


class TestGmailWatchServiceLifecycle:
    @pytest.mark.asyncio
    async def test_start_without_gog_binary(
        self, mock_config: GmailWatchConfig
    ) -> None:
        """Service should log a warning and NOT start when gog is missing."""
        service = GmailWatchService(mock_config)

        with patch(
            "elizaos_plugin_gmail_watch.service.find_gog_binary", return_value=None
        ):
            await service.start()

        assert service.is_running is False

    @pytest.mark.asyncio
    async def test_start_with_invalid_config(self) -> None:
        """Service should not start when config validation fails."""
        bad_config = GmailWatchConfig(account="", renew_every_minutes=0)
        service = GmailWatchService(bad_config)

        await service.start()
        assert service.is_running is False

    @pytest.mark.asyncio
    async def test_start_and_stop(self, mock_config: GmailWatchConfig) -> None:
        """Service should start and stop cleanly with a mocked subprocess."""
        service = GmailWatchService(mock_config)

        wait_future: asyncio.Future[int] = asyncio.get_event_loop().create_future()
        wait_future.set_result(0)

        mock_proc = AsyncMock(spec=asyncio.subprocess.Process)
        mock_proc.stdout = None
        mock_proc.stderr = None
        mock_proc.wait = AsyncMock(return_value=0)
        mock_proc.send_signal = MagicMock()

        with (
            patch(
                "elizaos_plugin_gmail_watch.service.find_gog_binary",
                return_value="/usr/bin/gog",
            ),
            patch(
                "elizaos_plugin_gmail_watch.service.asyncio.create_subprocess_exec",
                return_value=mock_proc,
            ),
        ):
            await service.start()
            assert service.is_running is True

            await service.stop()
            assert service.is_running is False

    @pytest.mark.asyncio
    async def test_stop_when_never_started(
        self, mock_config: GmailWatchConfig
    ) -> None:
        """Stopping a never-started service should not raise."""
        service = GmailWatchService(mock_config)
        await service.stop()
        assert service.is_running is False


# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------


class TestProcessManagement:
    @pytest.mark.asyncio
    async def test_restart_counter_reset_on_spawn(
        self, mock_config: GmailWatchConfig
    ) -> None:
        """Restart attempts should be reset to 0 after a successful spawn."""
        service = GmailWatchService(mock_config)
        service._restart_attempts = 5

        mock_proc = AsyncMock(spec=asyncio.subprocess.Process)
        mock_proc.stdout = None
        mock_proc.stderr = None
        mock_proc.wait = AsyncMock(side_effect=asyncio.CancelledError)

        with patch(
            "elizaos_plugin_gmail_watch.service.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await service._spawn_watcher()

        assert service.restart_attempts == 0

    def test_service_initial_state(self, mock_config: GmailWatchConfig) -> None:
        """A newly created service should have clean initial state."""
        service = GmailWatchService(mock_config)
        assert service.is_running is False
        assert service.restart_attempts == 0
        assert service.config == mock_config

    def test_config_accessible(self, mock_config: GmailWatchConfig) -> None:
        """The config property should return the original config."""
        service = GmailWatchService(mock_config)
        assert service.config.account == "user@gmail.com"
        assert service.config.renew_every_minutes == 360


# ---------------------------------------------------------------------------
# Renewal timing
# ---------------------------------------------------------------------------


class TestRenewalTiming:
    def test_renew_interval_calculation(
        self, mock_config: GmailWatchConfig
    ) -> None:
        """Renewal interval should be renew_every_minutes * 60 seconds."""
        interval_s = mock_config.renew_every_minutes * 60
        assert interval_s == 21600  # 6 hours in seconds

    def test_custom_renewal_interval(self) -> None:
        """Custom renewal minutes should calculate correctly."""
        config = GmailWatchConfig(account="a@b.com", renew_every_minutes=30)
        assert config.renew_every_minutes * 60 == 1800
