"""Tests for LINE plugin actions."""

from elizaos_plugin_line.actions import (
    send_flex_message_action,
    send_location_action,
    send_message_action,
)
from elizaos_plugin_line.actions.send_flex_message import create_info_bubble

# ---------------------------------------------------------------------------
# Action metadata
# ---------------------------------------------------------------------------


def test_send_message_action_metadata():
    assert send_message_action["name"] == "LINE_SEND_MESSAGE"
    assert "LINE" in send_message_action["description"]
    assert "SEND_LINE_MESSAGE" in send_message_action["similes"]
    assert "LINE_MESSAGE" in send_message_action["similes"]
    assert "LINE_TEXT" in send_message_action["similes"]
    assert "MESSAGE_LINE" in send_message_action["similes"]
    assert callable(send_message_action["validate"])
    assert callable(send_message_action["handler"])
    assert isinstance(send_message_action["examples"], list)
    assert len(send_message_action["examples"]) > 0


def test_send_flex_message_action_metadata():
    assert send_flex_message_action["name"] == "LINE_SEND_FLEX_MESSAGE"
    assert "LINE" in send_flex_message_action["description"]
    assert "LINE_FLEX" in send_flex_message_action["similes"]
    assert "LINE_CARD" in send_flex_message_action["similes"]
    assert "SEND_LINE_CARD" in send_flex_message_action["similes"]
    assert "SEND_LINE_FLEX" in send_flex_message_action["similes"]
    assert callable(send_flex_message_action["validate"])
    assert callable(send_flex_message_action["handler"])


def test_send_location_action_metadata():
    assert send_location_action["name"] == "LINE_SEND_LOCATION"
    assert "LINE" in send_location_action["description"]
    assert "LINE_LOCATION" in send_location_action["similes"]
    assert "LINE_MAP" in send_location_action["similes"]
    assert "SEND_LINE_LOCATION" in send_location_action["similes"]
    assert "SHARE_LOCATION_LINE" in send_location_action["similes"]
    assert callable(send_location_action["validate"])
    assert callable(send_location_action["handler"])


# ---------------------------------------------------------------------------
# Flex message formatting
# ---------------------------------------------------------------------------


def test_create_info_bubble_structure():
    bubble = create_info_bubble("Test Title", "Test Body")
    assert bubble["type"] == "bubble"
    assert bubble["body"]["type"] == "box"
    assert bubble["body"]["layout"] == "vertical"
    contents = bubble["body"]["contents"]
    assert len(contents) == 2


def test_create_info_bubble_title():
    bubble = create_info_bubble("My Title", "My Body")
    title_elem = bubble["body"]["contents"][0]
    assert title_elem["type"] == "text"
    assert title_elem["text"] == "My Title"
    assert title_elem["weight"] == "bold"
    assert title_elem["size"] == "xl"
    assert title_elem["wrap"] is True


def test_create_info_bubble_body():
    bubble = create_info_bubble("My Title", "My Body")
    body_elem = bubble["body"]["contents"][1]
    assert body_elem["type"] == "text"
    assert body_elem["text"] == "My Body"
    assert body_elem["margin"] == "md"
    assert body_elem["wrap"] is True


def test_create_info_bubble_special_chars():
    bubble = create_info_bubble("Title with <html>", 'Body with "quotes"')
    assert bubble["body"]["contents"][0]["text"] == "Title with <html>"
    assert bubble["body"]["contents"][1]["text"] == 'Body with "quotes"'


# ---------------------------------------------------------------------------
# Action validation
# ---------------------------------------------------------------------------


class MockMessage:
    """Mock message for testing action validation."""

    def __init__(self, source: str = "line"):
        self.content = {"source": source}


class MockRuntime:
    """Mock runtime for testing."""

    def get_service(self, name: str):
        return None


import pytest


@pytest.mark.asyncio
async def test_validate_line_source():
    """Validation should pass for LINE-sourced messages."""
    msg = MockMessage(source="line")
    result = await send_message_action["validate"](MockRuntime(), msg)
    assert result is True


@pytest.mark.asyncio
async def test_validate_non_line_source():
    """Validation should fail for non-LINE-sourced messages."""
    msg = MockMessage(source="discord")
    result = await send_message_action["validate"](MockRuntime(), msg)
    assert result is False


@pytest.mark.asyncio
async def test_flex_validate_line_source():
    msg = MockMessage(source="line")
    result = await send_flex_message_action["validate"](MockRuntime(), msg)
    assert result is True


@pytest.mark.asyncio
async def test_location_validate_line_source():
    msg = MockMessage(source="line")
    result = await send_location_action["validate"](MockRuntime(), msg)
    assert result is True
