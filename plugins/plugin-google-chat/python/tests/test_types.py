"""Tests for Google Chat plugin types and utility functions."""

import pytest

from elizaos_plugin_google_chat.types import (
    GOOGLE_CHAT_SERVICE_NAME,
    MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
    GoogleChatAnnotation,
    GoogleChatApiError,
    GoogleChatAttachment,
    GoogleChatAuthenticationError,
    GoogleChatConfigurationError,
    GoogleChatEvent,
    GoogleChatEventTypes,
    GoogleChatMessage,
    GoogleChatMessageSendOptions,
    GoogleChatPluginError,
    GoogleChatReaction,
    GoogleChatSendResult,
    GoogleChatSettings,
    GoogleChatSpace,
    GoogleChatThread,
    GoogleChatUser,
    extract_resource_id,
    get_space_display_name,
    get_user_display_name,
    is_direct_message,
    is_valid_google_chat_space_name,
    is_valid_google_chat_user_name,
    normalize_space_target,
    normalize_user_target,
    split_message_for_google_chat,
)


class TestConstants:
    def test_max_message_length(self):
        assert MAX_GOOGLE_CHAT_MESSAGE_LENGTH == 4000

    def test_service_name(self):
        assert GOOGLE_CHAT_SERVICE_NAME == "google-chat"


class TestGoogleChatEventTypes:
    def test_event_type_values(self):
        assert GoogleChatEventTypes.MESSAGE_RECEIVED == "GOOGLE_CHAT_MESSAGE_RECEIVED"
        assert GoogleChatEventTypes.MESSAGE_SENT == "GOOGLE_CHAT_MESSAGE_SENT"
        assert GoogleChatEventTypes.SPACE_JOINED == "GOOGLE_CHAT_SPACE_JOINED"
        assert GoogleChatEventTypes.SPACE_LEFT == "GOOGLE_CHAT_SPACE_LEFT"
        assert GoogleChatEventTypes.REACTION_RECEIVED == "GOOGLE_CHAT_REACTION_RECEIVED"
        assert GoogleChatEventTypes.REACTION_SENT == "GOOGLE_CHAT_REACTION_SENT"
        assert GoogleChatEventTypes.WEBHOOK_READY == "GOOGLE_CHAT_WEBHOOK_READY"
        assert GoogleChatEventTypes.CONNECTION_READY == "GOOGLE_CHAT_CONNECTION_READY"

    def test_event_type_count(self):
        values = list(GoogleChatEventTypes)
        assert len(values) == 8


class TestGoogleChatSettings:
    def test_default_settings(self):
        settings = GoogleChatSettings()
        assert settings.service_account is None
        assert settings.service_account_file is None
        assert settings.audience_type == "app-url"
        assert settings.audience == ""
        assert settings.webhook_path == "/googlechat"
        assert settings.spaces == []
        assert settings.require_mention is True
        assert settings.enabled is True
        assert settings.bot_user is None

    def test_custom_settings(self, mock_settings):
        assert mock_settings.audience_type == "app-url"
        assert mock_settings.audience == "https://test.example.com"
        assert mock_settings.webhook_path == "/googlechat"
        assert mock_settings.spaces == ["spaces/AAAA"]
        assert mock_settings.require_mention is True
        assert mock_settings.enabled is True


class TestGoogleChatSpace:
    def test_space_creation(self, mock_space):
        assert mock_space.name == "spaces/ABC123"
        assert mock_space.display_name == "Engineering Team"
        assert mock_space.type == "SPACE"
        assert mock_space.single_user_bot_dm is False
        assert mock_space.threaded is False

    def test_dm_space_creation(self, mock_dm_space):
        assert mock_dm_space.name == "spaces/DM456"
        assert mock_dm_space.display_name is None
        assert mock_dm_space.type == "DM"
        assert mock_dm_space.single_user_bot_dm is True

    def test_default_space(self):
        space = GoogleChatSpace(name="spaces/TEST")
        assert space.type == "SPACE"
        assert space.single_user_bot_dm is False
        assert space.threaded is False


class TestGoogleChatUser:
    def test_user_creation(self, mock_user):
        assert mock_user.name == "users/USER123"
        assert mock_user.display_name == "Jane Doe"
        assert mock_user.email == "jane@example.com"
        assert mock_user.type == "HUMAN"

    def test_bot_user(self, mock_bot_user):
        assert mock_bot_user.name == "users/BOT456"
        assert mock_bot_user.display_name == "Test Bot"
        assert mock_bot_user.type == "BOT"

    def test_default_user(self):
        user = GoogleChatUser(name="users/MIN")
        assert user.display_name is None
        assert user.email is None
        assert user.type is None
        assert user.is_anonymous is False


class TestGoogleChatThread:
    def test_thread_creation(self):
        thread = GoogleChatThread(name="spaces/ABC/threads/T1")
        assert thread.name == "spaces/ABC/threads/T1"
        assert thread.thread_key is None

    def test_thread_with_key(self):
        thread = GoogleChatThread(name="spaces/ABC/threads/T2", thread_key="my-key")
        assert thread.thread_key == "my-key"


class TestGoogleChatMessage:
    def test_message_creation(self, mock_user, mock_space):
        msg = GoogleChatMessage(
            name="spaces/ABC/messages/MSG1",
            sender=mock_user,
            space=mock_space,
            create_time="2024-01-01T00:00:00Z",
            text="Hello, world!",
        )
        assert msg.name == "spaces/ABC/messages/MSG1"
        assert msg.text == "Hello, world!"
        assert msg.sender.name == "users/USER123"
        assert msg.space.name == "spaces/ABC123"

    def test_message_defaults(self, mock_user, mock_space):
        msg = GoogleChatMessage(
            name="spaces/ABC/messages/MSG2",
            sender=mock_user,
            space=mock_space,
            create_time="2024-01-01T00:00:00Z",
        )
        assert msg.text is None
        assert msg.argument_text is None
        assert msg.thread is None
        assert msg.attachments == []
        assert msg.annotations == []


class TestGoogleChatMessageSendOptions:
    def test_default_options(self):
        opts = GoogleChatMessageSendOptions()
        assert opts.space is None
        assert opts.thread is None
        assert opts.text is None
        assert opts.attachments == []

    def test_full_options(self):
        opts = GoogleChatMessageSendOptions(
            space="spaces/ABC",
            thread="spaces/ABC/threads/T1",
            text="Hello!",
            attachments=[{"attachmentUploadToken": "tok1"}],
        )
        assert opts.space == "spaces/ABC"
        assert opts.thread == "spaces/ABC/threads/T1"
        assert opts.text == "Hello!"
        assert len(opts.attachments) == 1


class TestGoogleChatSendResult:
    def test_success_result(self):
        result = GoogleChatSendResult(
            success=True,
            message_name="spaces/ABC/messages/MSG1",
            space="spaces/ABC",
        )
        assert result.success is True
        assert result.message_name == "spaces/ABC/messages/MSG1"
        assert result.error is None

    def test_error_result(self):
        result = GoogleChatSendResult(
            success=False,
            error="Space is required",
        )
        assert result.success is False
        assert result.message_name is None
        assert result.error == "Space is required"


class TestIsValidGoogleChatSpaceName:
    def test_valid_space_names(self):
        assert is_valid_google_chat_space_name("spaces/ABC123") is True
        assert is_valid_google_chat_space_name("spaces/abc-def") is True
        assert is_valid_google_chat_space_name("spaces/test_space") is True
        assert is_valid_google_chat_space_name("spaces/A") is True

    def test_invalid_space_names(self):
        assert is_valid_google_chat_space_name("") is False
        assert is_valid_google_chat_space_name("spaces/") is False
        assert is_valid_google_chat_space_name("ABC123") is False
        assert is_valid_google_chat_space_name("users/ABC123") is False
        assert is_valid_google_chat_space_name("spaces/abc def") is False
        assert is_valid_google_chat_space_name("spaces/abc/def") is False
        assert is_valid_google_chat_space_name("spaces/abc.def") is False


class TestIsValidGoogleChatUserName:
    def test_valid_user_names(self):
        assert is_valid_google_chat_user_name("users/ABC123") is True
        assert is_valid_google_chat_user_name("users/abc-def") is True
        assert is_valid_google_chat_user_name("users/test_user") is True
        assert is_valid_google_chat_user_name("users/A") is True

    def test_invalid_user_names(self):
        assert is_valid_google_chat_user_name("") is False
        assert is_valid_google_chat_user_name("users/") is False
        assert is_valid_google_chat_user_name("ABC123") is False
        assert is_valid_google_chat_user_name("spaces/ABC123") is False
        assert is_valid_google_chat_user_name("users/abc def") is False
        assert is_valid_google_chat_user_name("users/abc/def") is False


class TestNormalizeSpaceTarget:
    def test_already_prefixed(self):
        assert normalize_space_target("spaces/ABC123") == "spaces/ABC123"

    def test_bare_id(self):
        assert normalize_space_target("ABC123") == "spaces/ABC123"
        assert normalize_space_target("my-space") == "spaces/my-space"
        assert normalize_space_target("space_name") == "spaces/space_name"

    def test_empty_string(self):
        assert normalize_space_target("") is None

    def test_whitespace_only(self):
        assert normalize_space_target("   ") is None

    def test_invalid_characters(self):
        assert normalize_space_target("abc def") is None
        assert normalize_space_target("abc/def") is None
        assert normalize_space_target("abc.def") is None

    def test_trims_whitespace(self):
        assert normalize_space_target("  spaces/ABC123  ") == "spaces/ABC123"
        assert normalize_space_target("  ABC123  ") == "spaces/ABC123"


class TestNormalizeUserTarget:
    def test_already_prefixed(self):
        assert normalize_user_target("users/ABC123") == "users/ABC123"

    def test_bare_id(self):
        assert normalize_user_target("ABC123") == "users/ABC123"
        assert normalize_user_target("user-name") == "users/user-name"
        assert normalize_user_target("user_id") == "users/user_id"

    def test_empty_string(self):
        assert normalize_user_target("") is None

    def test_whitespace_only(self):
        assert normalize_user_target("   ") is None

    def test_invalid_characters(self):
        assert normalize_user_target("abc def") is None
        assert normalize_user_target("abc/def") is None

    def test_trims_whitespace(self):
        assert normalize_user_target("  users/ABC123  ") == "users/ABC123"
        assert normalize_user_target("  ABC123  ") == "users/ABC123"


class TestExtractResourceId:
    def test_space_resource(self):
        assert extract_resource_id("spaces/ABC123") == "ABC123"

    def test_user_resource(self):
        assert extract_resource_id("users/DEF456") == "DEF456"

    def test_message_resource(self):
        assert extract_resource_id("spaces/ABC/messages/MSG123") == "MSG123"

    def test_reaction_resource(self):
        assert extract_resource_id("spaces/ABC/messages/MSG/reactions/RXN1") == "RXN1"

    def test_no_slashes(self):
        assert extract_resource_id("standalone") == "standalone"

    def test_empty_string(self):
        assert extract_resource_id("") == ""


class TestGetUserDisplayName:
    def test_with_display_name(self, mock_user):
        assert get_user_display_name(mock_user) == "Jane Doe"

    def test_without_display_name(self):
        user = GoogleChatUser(name="users/FALLBACK")
        assert get_user_display_name(user) == "FALLBACK"

    def test_with_none_display_name(self):
        user = GoogleChatUser(name="users/XYZ789", display_name=None)
        assert get_user_display_name(user) == "XYZ789"


class TestGetSpaceDisplayName:
    def test_with_display_name(self, mock_space):
        assert get_space_display_name(mock_space) == "Engineering Team"

    def test_without_display_name(self):
        space = GoogleChatSpace(name="spaces/FALLBACK")
        assert get_space_display_name(space) == "FALLBACK"

    def test_with_none_display_name(self):
        space = GoogleChatSpace(name="spaces/DEF456", display_name=None)
        assert get_space_display_name(space) == "DEF456"


class TestIsDirectMessage:
    def test_dm_type(self, mock_dm_space):
        assert is_direct_message(mock_dm_space) is True

    def test_bot_dm(self):
        space = GoogleChatSpace(name="spaces/BOT", type="SPACE", single_user_bot_dm=True)
        assert is_direct_message(space) is True

    def test_regular_space(self, mock_space):
        assert is_direct_message(mock_space) is False

    def test_room_type(self):
        space = GoogleChatSpace(name="spaces/ROOM", type="ROOM")
        assert is_direct_message(space) is False


class TestSplitMessageForGoogleChat:
    def test_short_text(self):
        result = split_message_for_google_chat("Hello, world!")
        assert result == ["Hello, world!"]

    def test_text_at_max_length(self):
        text = "a" * MAX_GOOGLE_CHAT_MESSAGE_LENGTH
        result = split_message_for_google_chat(text)
        assert result == [text]

    def test_text_exceeding_max_length(self):
        text = "a" * (MAX_GOOGLE_CHAT_MESSAGE_LENGTH + 100)
        result = split_message_for_google_chat(text)
        assert len(result) > 1

    def test_split_at_newline(self):
        part1 = "a" * 2500
        part2 = "b" * 2500
        text = f"{part1}\n{part2}"
        result = split_message_for_google_chat(text, 3000)
        assert len(result) == 2
        assert result[0] == part1
        assert result[1] == part2

    def test_split_at_space(self):
        words = " ".join(["word"] * 200)
        result = split_message_for_google_chat(words, 50)
        assert len(result) > 1
        for chunk in result:
            assert len(chunk) <= 50

    def test_empty_string(self):
        result = split_message_for_google_chat("")
        assert result == [""]

    def test_custom_max_length(self):
        text = "a" * 200
        result = split_message_for_google_chat(text, 100)
        assert len(result) == 2

    def test_chunks_are_trimmed(self):
        text = "a" * 2500 + "\n" + "b" * 2500
        result = split_message_for_google_chat(text, 3000)
        for chunk in result:
            assert chunk == chunk.strip()


class TestErrorClasses:
    class TestGoogleChatPluginError:
        def test_stores_message_and_code(self):
            err = GoogleChatPluginError("test error", "TEST_CODE")
            assert str(err) == "test error"
            assert err.code == "TEST_CODE"

        def test_stores_cause(self):
            cause = ValueError("root cause")
            err = GoogleChatPluginError("test error", "TEST_CODE", cause)
            assert err.cause is cause

        def test_is_instance_of_exception(self):
            err = GoogleChatPluginError("test", "CODE")
            assert isinstance(err, Exception)

    class TestGoogleChatConfigurationError:
        def test_has_configuration_error_code(self):
            err = GoogleChatConfigurationError("bad config")
            assert err.code == "CONFIGURATION_ERROR"

        def test_stores_setting_name(self):
            err = GoogleChatConfigurationError("missing value", "GOOGLE_CHAT_AUDIENCE")
            assert err.setting == "GOOGLE_CHAT_AUDIENCE"

        def test_inherits_from_plugin_error(self):
            err = GoogleChatConfigurationError("test")
            assert isinstance(err, GoogleChatPluginError)
            assert isinstance(err, Exception)

        def test_no_setting_name(self):
            err = GoogleChatConfigurationError("test")
            assert err.setting is None

    class TestGoogleChatApiError:
        def test_has_api_error_code(self):
            err = GoogleChatApiError("api failure")
            assert err.code == "API_ERROR"

        def test_stores_status_code(self):
            err = GoogleChatApiError("not found", 404)
            assert err.status_code == 404

        def test_inherits_from_plugin_error(self):
            err = GoogleChatApiError("test")
            assert isinstance(err, GoogleChatPluginError)

        def test_common_http_status_codes(self):
            assert GoogleChatApiError("bad request", 400).status_code == 400
            assert GoogleChatApiError("unauthorized", 401).status_code == 401
            assert GoogleChatApiError("forbidden", 403).status_code == 403
            assert GoogleChatApiError("server error", 500).status_code == 500

    class TestGoogleChatAuthenticationError:
        def test_has_authentication_error_code(self):
            err = GoogleChatAuthenticationError("auth failed")
            assert err.code == "AUTHENTICATION_ERROR"

        def test_inherits_from_plugin_error(self):
            err = GoogleChatAuthenticationError("test")
            assert isinstance(err, GoogleChatPluginError)
            assert isinstance(err, Exception)

        def test_stores_cause(self):
            cause = RuntimeError("token expired")
            err = GoogleChatAuthenticationError("auth failed", cause)
            assert err.cause is cause
