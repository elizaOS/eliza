"""Tests for LINE plugin type definitions."""

from elizaos_plugin_line.types import (
    LINE_SERVICE_NAME,
    MAX_LINE_BATCH_SIZE,
    MAX_LINE_MESSAGE_LENGTH,
    LineApiError,
    LineEventTypes,
    LineFlexMessage,
    LineGroup,
    LineLocationMessage,
    LineMessage,
    LinePluginError,
    LineSendResult,
    LineSettings,
    LineTemplateMessage,
    LineUser,
    get_chat_type_from_id,
    is_valid_line_group_id,
    is_valid_line_id,
    is_valid_line_room_id,
    is_valid_line_user_id,
    normalize_line_target,
    split_message_for_line,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_constants():
    assert MAX_LINE_MESSAGE_LENGTH == 5000
    assert MAX_LINE_BATCH_SIZE == 5
    assert LINE_SERVICE_NAME == "line"


# ---------------------------------------------------------------------------
# Event types
# ---------------------------------------------------------------------------


def test_event_types():
    assert LineEventTypes.MESSAGE_RECEIVED == "LINE_MESSAGE_RECEIVED"
    assert LineEventTypes.MESSAGE_SENT == "LINE_MESSAGE_SENT"
    assert LineEventTypes.FOLLOW == "LINE_FOLLOW"
    assert LineEventTypes.UNFOLLOW == "LINE_UNFOLLOW"
    assert LineEventTypes.JOIN_GROUP == "LINE_JOIN_GROUP"
    assert LineEventTypes.LEAVE_GROUP == "LINE_LEAVE_GROUP"
    assert LineEventTypes.POSTBACK == "LINE_POSTBACK"
    assert LineEventTypes.CONNECTION_READY == "LINE_CONNECTION_READY"


# ---------------------------------------------------------------------------
# ID validation
# ---------------------------------------------------------------------------


def test_valid_user_id():
    assert is_valid_line_user_id("U1234567890abcdef1234567890abcdef")
    assert is_valid_line_user_id("UABCDEF1234567890ABCDEF1234567890")


def test_invalid_user_id():
    assert not is_valid_line_user_id("C1234567890abcdef1234567890abcdef")
    assert not is_valid_line_user_id("U123")
    assert not is_valid_line_user_id("")
    assert not is_valid_line_user_id("invalid")


def test_valid_group_id():
    assert is_valid_line_group_id("C1234567890abcdef1234567890abcdef")


def test_invalid_group_id():
    assert not is_valid_line_group_id("U1234567890abcdef1234567890abcdef")
    assert not is_valid_line_group_id("C123")
    assert not is_valid_line_group_id("")


def test_valid_room_id():
    assert is_valid_line_room_id("R1234567890abcdef1234567890abcdef")


def test_invalid_room_id():
    assert not is_valid_line_room_id("U1234567890abcdef1234567890abcdef")
    assert not is_valid_line_room_id("R123")


def test_is_valid_line_id_any():
    assert is_valid_line_id("U1234567890abcdef1234567890abcdef")
    assert is_valid_line_id("C1234567890abcdef1234567890abcdef")
    assert is_valid_line_id("R1234567890abcdef1234567890abcdef")
    assert not is_valid_line_id("X1234567890abcdef1234567890abcdef")
    assert not is_valid_line_id("")


def test_is_valid_line_id_whitespace():
    assert is_valid_line_id(" U1234567890abcdef1234567890abcdef ")


# ---------------------------------------------------------------------------
# normalize_line_target
# ---------------------------------------------------------------------------


def test_normalize_plain_id():
    result = normalize_line_target("U1234567890abcdef1234567890abcdef")
    assert result == "U1234567890abcdef1234567890abcdef"


def test_normalize_with_prefix():
    result = normalize_line_target("line:user:U1234567890abcdef1234567890abcdef")
    assert result == "U1234567890abcdef1234567890abcdef"


def test_normalize_empty():
    assert normalize_line_target("") is None
    assert normalize_line_target("   ") is None


# ---------------------------------------------------------------------------
# get_chat_type_from_id
# ---------------------------------------------------------------------------


def test_chat_type_user():
    assert get_chat_type_from_id("U1234567890abcdef1234567890abcdef") == "user"


def test_chat_type_group():
    assert get_chat_type_from_id("C1234567890abcdef1234567890abcdef") == "group"


def test_chat_type_room():
    assert get_chat_type_from_id("R1234567890abcdef1234567890abcdef") == "room"


def test_chat_type_invalid():
    assert get_chat_type_from_id("invalid") is None


# ---------------------------------------------------------------------------
# split_message_for_line
# ---------------------------------------------------------------------------


def test_split_short_message():
    assert split_message_for_line("Hello") == ["Hello"]


def test_split_exact_limit():
    text = "a" * MAX_LINE_MESSAGE_LENGTH
    chunks = split_message_for_line(text)
    assert len(chunks) == 1
    assert len(chunks[0]) == MAX_LINE_MESSAGE_LENGTH


def test_split_over_limit():
    text = "a" * 6000
    chunks = split_message_for_line(text, max_length=1000)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 1000


def test_split_at_newline():
    first = "a" * 600
    second = "b" * 200
    text = f"{first}\n{second}"
    chunks = split_message_for_line(text, max_length=700)
    assert len(chunks) == 2
    assert chunks[0] == first
    assert chunks[1] == second


def test_split_at_space():
    first = "a" * 600
    second = "b" * 200
    text = f"{first} {second}"
    chunks = split_message_for_line(text, max_length=700)
    assert len(chunks) == 2


# ---------------------------------------------------------------------------
# Type construction
# ---------------------------------------------------------------------------


def test_line_user():
    user = LineUser(
        user_id="U123",
        display_name="Test",
        picture_url="https://example.com/pic.jpg",
        status_message="Hello",
        language="ja",
    )
    assert user.user_id == "U123"
    assert user.display_name == "Test"
    assert user.language == "ja"


def test_line_user_optional_defaults():
    user = LineUser(user_id="U123", display_name="Test")
    assert user.picture_url is None
    assert user.status_message is None
    assert user.language is None


def test_line_group():
    group = LineGroup(
        group_id="C123",
        group_type="group",
        group_name="Test Group",
        member_count=42,
    )
    assert group.group_id == "C123"
    assert group.group_name == "Test Group"
    assert group.member_count == 42


def test_line_message():
    msg = LineMessage(
        id="msg1",
        message_type="text",
        user_id="U123",
        timestamp=1234567890,
        text="Hello",
        reply_token="token123",
    )
    assert msg.id == "msg1"
    assert msg.message_type == "text"
    assert msg.text == "Hello"


def test_line_send_result_success():
    result = LineSendResult(success=True, message_id="id1", chat_id="chat1")
    assert result.success is True
    assert result.message_id == "id1"
    assert result.error is None


def test_line_send_result_failure():
    result = LineSendResult(success=False, error="Something failed")
    assert result.success is False
    assert result.error == "Something failed"
    assert result.message_id is None


def test_line_flex_message():
    flex = LineFlexMessage(
        alt_text="Card notification",
        contents={
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    {"type": "text", "text": "Title", "weight": "bold"},
                    {"type": "text", "text": "Body"},
                ],
            },
        },
    )
    assert flex.alt_text == "Card notification"
    assert flex.contents["type"] == "bubble"


def test_line_template_message():
    template = LineTemplateMessage(
        template_type="confirm",
        alt_text="Confirm action",
        template={
            "type": "confirm",
            "text": "Are you sure?",
            "actions": [
                {"type": "message", "label": "Yes", "text": "yes"},
                {"type": "message", "label": "No", "text": "no"},
            ],
        },
    )
    assert template.template_type == "confirm"
    assert template.template["text"] == "Are you sure?"


def test_line_location_message():
    loc = LineLocationMessage(
        title="Tokyo Tower",
        address="4 Chome-2-8 Shibakoen",
        latitude=35.6586,
        longitude=139.7454,
    )
    assert loc.title == "Tokyo Tower"
    assert abs(loc.latitude - 35.6586) < 0.0001
    assert abs(loc.longitude - 139.7454) < 0.0001


# ---------------------------------------------------------------------------
# Error types
# ---------------------------------------------------------------------------


def test_line_plugin_error():
    err = LinePluginError("Something failed", "CUSTOM_CODE", {"key": "val"})
    assert str(err) == "Something failed"
    assert err.code == "CUSTOM_CODE"
    assert err.details == {"key": "val"}


def test_line_api_error():
    err = LineApiError("Not found", status_code=404, body='{"error":"not found"}')
    assert str(err) == "Not found"
    assert err.code == "API_ERROR"
    assert err.details["status_code"] == 404
    assert err.details["body"] == '{"error":"not found"}'
