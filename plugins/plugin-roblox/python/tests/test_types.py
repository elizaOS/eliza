from datetime import datetime
from uuid import uuid4

from elizaos_plugin_roblox.types import (
    CreatorType,
    ExperienceCreator,
    MessageSender,
    MessagingServiceMessage,
    RobloxEventType,
    RobloxExperienceInfo,
    RobloxUser,
)


def test_roblox_user() -> None:
    user = RobloxUser(
        id=12345,
        username="testuser",
        display_name="Test User",
    )
    assert user.id == 12345
    assert user.username == "testuser"
    assert user.display_name == "Test User"
    assert user.avatar_url is None
    assert not user.is_banned


def test_roblox_user_with_all_fields() -> None:
    now = datetime.now()
    user = RobloxUser(
        id=12345,
        username="testuser",
        display_name="Test User",
        avatar_url="https://example.com/avatar.png",
        created_at=now,
        is_banned=True,
    )
    assert user.avatar_url == "https://example.com/avatar.png"
    assert user.created_at == now
    assert user.is_banned


def test_messaging_service_message() -> None:
    agent_id = uuid4()
    message = MessagingServiceMessage(
        topic="test-topic",
        data={"content": "Hello"},
        sender=MessageSender(agent_id=agent_id, agent_name="TestAgent"),
    )
    assert message.topic == "test-topic"
    assert message.data == {"content": "Hello"}
    assert message.sender is not None
    assert message.sender.agent_id == agent_id


def test_roblox_event_type() -> None:
    assert RobloxEventType.PLAYER_JOINED.value == "roblox:player_joined"
    assert RobloxEventType.PLAYER_LEFT.value == "roblox:player_left"
    assert RobloxEventType.PLAYER_MESSAGE.value == "roblox:player_message"


def test_experience_info() -> None:
    info = RobloxExperienceInfo(
        universe_id="12345",
        name="Test Game",
        creator=ExperienceCreator(
            id=1,
            creator_type=CreatorType.USER,
            name="TestCreator",
        ),
        playing=100,
        visits=1000000,
        root_place_id="67890",
    )
    assert info.universe_id == "12345"
    assert info.name == "Test Game"
    assert info.creator.creator_type == CreatorType.USER
    assert info.playing == 100
