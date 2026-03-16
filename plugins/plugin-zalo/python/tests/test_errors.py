"""Tests for plugin-zalo error module."""

from elizaos_plugin_zalo.error import (
    ApiError,
    ClientNotInitializedError,
    ConfigError,
    MessageSendError,
    TokenRefreshError,
    UserNotFoundError,
    ZaloError,
)


class TestErrorHierarchy:
    """All errors inherit from ZaloError."""

    def test_api_error_is_zalo_error(self) -> None:
        err = ApiError("test")
        assert isinstance(err, ZaloError)

    def test_config_error_is_zalo_error(self) -> None:
        err = ConfigError("test")
        assert isinstance(err, ZaloError)

    def test_client_not_initialized_is_zalo_error(self) -> None:
        err = ClientNotInitializedError()
        assert isinstance(err, ZaloError)

    def test_message_send_error_is_zalo_error(self) -> None:
        err = MessageSendError("user1")
        assert isinstance(err, ZaloError)

    def test_token_refresh_error_is_zalo_error(self) -> None:
        err = TokenRefreshError("test")
        assert isinstance(err, ZaloError)

    def test_user_not_found_is_zalo_error(self) -> None:
        err = UserNotFoundError("user1")
        assert isinstance(err, ZaloError)


class TestApiError:
    def test_message(self) -> None:
        err = ApiError("Bad request", error_code=400)
        assert "Bad request" in str(err)

    def test_error_code(self) -> None:
        err = ApiError("err", error_code=401)
        assert err.error_code == 401

    def test_default_error_code(self) -> None:
        err = ApiError("err")
        assert err.error_code is None


class TestClientNotInitializedError:
    def test_message(self) -> None:
        err = ClientNotInitializedError()
        assert "not initialized" in str(err)


class TestMessageSendError:
    def test_message_includes_user_id(self) -> None:
        err = MessageSendError("user-42")
        assert "user-42" in str(err)

    def test_user_id_attribute(self) -> None:
        err = MessageSendError("user-42")
        assert err.user_id == "user-42"

    def test_cause_attribute(self) -> None:
        cause = RuntimeError("network")
        err = MessageSendError("user-1", cause=cause)
        assert err.cause is cause

    def test_default_cause_is_none(self) -> None:
        err = MessageSendError("user-1")
        assert err.cause is None


class TestUserNotFoundError:
    def test_message_includes_user_id(self) -> None:
        err = UserNotFoundError("user-99")
        assert "user-99" in str(err)

    def test_user_id_attribute(self) -> None:
        err = UserNotFoundError("user-99")
        assert err.user_id == "user-99"
