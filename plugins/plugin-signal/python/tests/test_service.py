"""
Tests for SignalService initialization and configuration validation.

Focuses on the synchronous/constructor-level logic that doesn't require
a live Signal API: settings validation, configuration error branches,
and object state after construction.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from elizaos_plugin_signal.service import SignalService
from elizaos_plugin_signal.types import (
    SignalConfigurationError,
    SignalContact,
    SignalGroup,
    SignalSettings,
    SIGNAL_SERVICE_NAME,
)


# =========================================================================
# Service metadata
# =========================================================================


class TestServiceMetadata:
    def test_service_type_constant(self):
        assert SignalService.service_type == SIGNAL_SERVICE_NAME

    def test_service_type_is_signal(self):
        assert SignalService.service_type == "signal"


# =========================================================================
# Constructor state
# =========================================================================


class TestServiceConstructor:
    def test_initial_state_not_connected(self):
        runtime = _make_runtime()
        service = SignalService(runtime)

        assert service.is_service_connected() is False
        assert service.get_account_number() is None
        assert service.settings is None

    def test_caches_start_empty(self):
        runtime = _make_runtime()
        service = SignalService(runtime)

        assert service._contacts_cache == {}
        assert service._groups_cache == {}


# =========================================================================
# _initialize – configuration validation
# =========================================================================


class TestServiceInitialization:
    @pytest.mark.asyncio
    async def test_raises_on_missing_account_number(self):
        runtime = _make_runtime(settings={
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })
        service = SignalService(runtime)

        with pytest.raises(SignalConfigurationError) as exc_info:
            await service._initialize()

        assert "SIGNAL_ACCOUNT_NUMBER" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_raises_on_invalid_phone_format(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "not-a-number",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })
        service = SignalService(runtime)

        with pytest.raises(SignalConfigurationError) as exc_info:
            await service._initialize()

        assert "invalid phone number" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_raises_when_neither_http_url_nor_cli_path(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "+14155551234",
        })
        service = SignalService(runtime)

        with pytest.raises(SignalConfigurationError) as exc_info:
            await service._initialize()

        assert "SIGNAL_HTTP_URL" in str(exc_info.value) or "SIGNAL_CLI_PATH" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_normalizes_account_number(self):
        """Account number with separators should be normalized to E.164."""
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "1-415-555-1234",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })
        service = SignalService(runtime)

        # Patch network calls
        with _patch_network():
            await service._initialize()

        assert service.settings.account_number == "+14155551234"

    @pytest.mark.asyncio
    async def test_parses_ignore_groups_true(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "+14155551234",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
            "SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES": "true",
        })
        service = SignalService(runtime)

        with _patch_network():
            await service._initialize()

        assert service.settings.should_ignore_group_messages is True

    @pytest.mark.asyncio
    async def test_parses_ignore_groups_false_default(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "+14155551234",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })
        service = SignalService(runtime)

        with _patch_network():
            await service._initialize()

        assert service.settings.should_ignore_group_messages is False

    @pytest.mark.asyncio
    async def test_connected_after_successful_init(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "+14155551234",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })
        service = SignalService(runtime)

        with _patch_network():
            await service._initialize()

        assert service.is_service_connected() is True


# =========================================================================
# Contact / group cache accessors
# =========================================================================


class TestServiceCacheAccessors:
    def test_get_contact_returns_cached(self):
        runtime = _make_runtime()
        service = SignalService(runtime)
        contact = SignalContact(number="+14155551234", name="Test")
        service._contacts_cache["+14155551234"] = contact

        result = service.get_contact("+14155551234")
        assert result is not None
        assert result.name == "Test"

    def test_get_contact_normalizes_input(self):
        runtime = _make_runtime()
        service = SignalService(runtime)
        contact = SignalContact(number="+14155551234", name="Test")
        service._contacts_cache["+14155551234"] = contact

        result = service.get_contact("1-415-555-1234")
        assert result is not None
        assert result.name == "Test"

    def test_get_contact_returns_none_for_unknown(self):
        runtime = _make_runtime()
        service = SignalService(runtime)

        assert service.get_contact("+19999999999") is None

    def test_get_contact_returns_none_for_invalid_number(self):
        runtime = _make_runtime()
        service = SignalService(runtime)

        assert service.get_contact("not-a-number") is None

    def test_get_cached_group_returns_cached(self):
        runtime = _make_runtime()
        service = SignalService(runtime)
        group = SignalGroup(id="group1", name="Test Group")
        service._groups_cache["group1"] = group

        result = service.get_cached_group("group1")
        assert result is not None
        assert result.name == "Test Group"

    def test_get_cached_group_returns_none_for_unknown(self):
        runtime = _make_runtime()
        service = SignalService(runtime)

        assert service.get_cached_group("nonexistent") is None


# =========================================================================
# stop()
# =========================================================================


class TestServiceStop:
    @pytest.mark.asyncio
    async def test_stop_sets_disconnected(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "+14155551234",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })
        service = SignalService(runtime)

        with _patch_network():
            await service._initialize()

        assert service.is_service_connected() is True

        await service.stop()

        assert service.is_service_connected() is False


# =========================================================================
# start() class method
# =========================================================================


class TestServiceStart:
    @pytest.mark.asyncio
    async def test_start_returns_service_instance(self):
        runtime = _make_runtime(settings={
            "SIGNAL_ACCOUNT_NUMBER": "+14155551234",
            "SIGNAL_HTTP_URL": "http://localhost:8080",
        })

        with _patch_network():
            service = await SignalService.start(runtime)

        assert isinstance(service, SignalService)
        assert service.is_service_connected() is True
        assert service.get_account_number() == "+14155551234"

        # Cleanup
        await service.stop()


# =========================================================================
# Helpers
# =========================================================================


def _make_runtime(*, settings: dict[str, str] | None = None):
    """Create a mock runtime with optional settings."""
    _settings = settings or {}

    class _Runtime:
        def get_setting(self, key: str):
            return _settings.get(key)

        async def emit_event(self, event_type: str, data: dict):
            pass

    return _Runtime()


class _FakeResponse:
    """Minimal aiohttp response stand-in."""

    def __init__(self, status: int = 200, body: str = "[]"):
        self.status = status
        self._body = body

    async def text(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def _patch_network():
    """Context manager that stubs out all aiohttp network calls during init."""
    import contextlib

    fake_session = MagicMock()
    fake_response = _FakeResponse(status=200, body="[]")

    # _verify_connection uses session.get(url)
    fake_session.get.return_value = _FakeResponse(status=200, body='{}')

    # _load_contacts and _load_groups use session.request(method, url, ...)
    fake_session.request.return_value = _FakeResponse(status=200, body='[]')

    # Also close should be async
    fake_session.close = AsyncMock()

    @contextlib.contextmanager
    def _patcher():
        with patch("aiohttp.ClientSession", return_value=fake_session):
            with patch.object(
                SignalService, "_verify_connection", new_callable=AsyncMock
            ):
                with patch.object(
                    SignalService, "_load_contacts", new_callable=AsyncMock
                ):
                    with patch.object(
                        SignalService, "_load_groups", new_callable=AsyncMock
                    ):
                        with patch.object(
                            SignalService, "_poll_messages", new_callable=AsyncMock
                        ):
                            yield

    return _patcher()
