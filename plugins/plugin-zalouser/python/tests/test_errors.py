"""Tests for plugin-zalouser error module."""

from elizaos_plugin_zalouser.error import (
    AlreadyRunningError,
    ApiError,
    ChatNotFoundError,
    ClientNotInitializedError,
    CommandError,
    InvalidArgumentError,
    InvalidConfigError,
    NotAuthenticatedError,
    NotRunningError,
    SendError,
    TimeoutError,
    UserNotFoundError,
    ZaloUserError,
    ZcaNotInstalledError,
)


class TestErrorHierarchy:
    """All errors inherit from ZaloUserError."""

    def test_zca_not_installed(self) -> None:
        assert isinstance(ZcaNotInstalledError(), ZaloUserError)

    def test_not_authenticated(self) -> None:
        assert isinstance(NotAuthenticatedError(), ZaloUserError)

    def test_invalid_config(self) -> None:
        assert isinstance(InvalidConfigError("bad"), ZaloUserError)

    def test_already_running(self) -> None:
        assert isinstance(AlreadyRunningError(), ZaloUserError)

    def test_not_running(self) -> None:
        assert isinstance(NotRunningError(), ZaloUserError)

    def test_client_not_initialized(self) -> None:
        assert isinstance(ClientNotInitializedError(), ZaloUserError)

    def test_command_error(self) -> None:
        assert isinstance(CommandError("fail"), ZaloUserError)

    def test_timeout_error(self) -> None:
        assert isinstance(TimeoutError(5000), ZaloUserError)

    def test_api_error(self) -> None:
        assert isinstance(ApiError("rate limit"), ZaloUserError)

    def test_send_error(self) -> None:
        assert isinstance(SendError("network"), ZaloUserError)

    def test_chat_not_found(self) -> None:
        assert isinstance(ChatNotFoundError("t1"), ZaloUserError)

    def test_user_not_found(self) -> None:
        assert isinstance(UserNotFoundError("u1"), ZaloUserError)

    def test_invalid_argument(self) -> None:
        assert isinstance(InvalidArgumentError("empty"), ZaloUserError)


class TestZcaNotInstalledError:
    def test_message_contains_install_instruction(self) -> None:
        err = ZcaNotInstalledError()
        assert "npm install" in str(err)

    def test_message_contains_zca_cli(self) -> None:
        err = ZcaNotInstalledError()
        assert "zca-cli" in str(err)


class TestNotAuthenticatedError:
    def test_default_message(self) -> None:
        err = NotAuthenticatedError()
        assert "Not authenticated" in str(err)

    def test_with_profile(self) -> None:
        err = NotAuthenticatedError(profile="work")
        assert "work" in str(err)

    def test_includes_auth_instruction(self) -> None:
        err = NotAuthenticatedError()
        assert "zca auth login" in str(err)


class TestInvalidConfigError:
    def test_message(self) -> None:
        err = InvalidConfigError("missing field")
        assert "missing field" in str(err)


class TestAlreadyRunningError:
    def test_message(self) -> None:
        err = AlreadyRunningError()
        assert "already running" in str(err)


class TestNotRunningError:
    def test_message(self) -> None:
        err = NotRunningError()
        assert "not running" in str(err)


class TestClientNotInitializedError:
    def test_message(self) -> None:
        err = ClientNotInitializedError()
        assert "not initialized" in str(err)


class TestCommandError:
    def test_message(self) -> None:
        err = CommandError("segfault")
        assert "segfault" in str(err)


class TestTimeoutError:
    def test_message_includes_timeout(self) -> None:
        err = TimeoutError(30000)
        assert "30000" in str(err)


class TestApiError:
    def test_message(self) -> None:
        err = ApiError("rate limit exceeded")
        assert "rate limit" in str(err)


class TestSendError:
    def test_message(self) -> None:
        err = SendError("network error")
        assert "network error" in str(err)


class TestChatNotFoundError:
    def test_message_includes_thread_id(self) -> None:
        err = ChatNotFoundError("thread-42")
        assert "thread-42" in str(err)


class TestUserNotFoundError:
    def test_message_includes_user_id(self) -> None:
        err = UserNotFoundError("user-99")
        assert "user-99" in str(err)


class TestInvalidArgumentError:
    def test_message(self) -> None:
        err = InvalidArgumentError("empty text")
        assert "empty text" in str(err)
