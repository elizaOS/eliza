from __future__ import annotations

from datetime import datetime

from elizaos_plugin_farcaster.types import (
    Cast,
    CastEmbed,
    CastId,
    CastParent,
    EmbedType,
    FarcasterEventType,
    FarcasterMessageType,
    Profile,
)


def test_profile_creation() -> None:
    profile = Profile(
        fid=12345,
        name="Test User",
        username="testuser",
        pfp="https://example.com/pfp.jpg",
        bio="A test user",
    )
    assert profile.fid == 12345
    assert profile.name == "Test User"
    assert profile.username == "testuser"
    assert profile.pfp == "https://example.com/pfp.jpg"
    assert profile.bio == "A test user"


def test_cast_creation() -> None:
    profile = Profile(fid=12345, name="Test", username="test")
    cast = Cast(
        hash="0xabc123",
        author_fid=12345,
        text="Hello Farcaster!",
        profile=profile,
        timestamp=datetime.now(),
    )
    assert cast.hash == "0xabc123"
    assert cast.author_fid == 12345
    assert cast.text == "Hello Farcaster!"
    assert cast.profile.username == "test"


def test_cast_with_reply() -> None:
    """Test creating a Cast with reply."""
    profile = Profile(fid=12345, name="Test", username="test")
    parent = CastParent(hash="0xparent", fid=54321)
    cast = Cast(
        hash="0xreply",
        author_fid=12345,
        text="This is a reply",
        profile=profile,
        timestamp=datetime.now(),
        in_reply_to=parent,
    )
    assert cast.in_reply_to is not None
    assert cast.in_reply_to.hash == "0xparent"
    assert cast.in_reply_to.fid == 54321


def test_cast_embed() -> None:
    embed = CastEmbed(
        type=EmbedType.IMAGE,
        url="https://example.com/image.jpg",
    )
    assert embed.type == EmbedType.IMAGE
    assert embed.url == "https://example.com/image.jpg"


def test_embed_types() -> None:
    """Test all embed types."""
    assert EmbedType.IMAGE.value == "image"
    assert EmbedType.VIDEO.value == "video"
    assert EmbedType.URL.value == "url"
    assert EmbedType.CAST.value == "cast"
    assert EmbedType.FRAME.value == "frame"


def test_message_types() -> None:
    assert FarcasterMessageType.CAST.value == "CAST"
    assert FarcasterMessageType.REPLY.value == "REPLY"


def test_event_types() -> None:
    assert FarcasterEventType.CAST_GENERATED.value == "FARCASTER_CAST_GENERATED"
    assert FarcasterEventType.MENTION_RECEIVED.value == "FARCASTER_MENTION_RECEIVED"


def test_cast_id() -> None:
    cast_id = CastId(hash="0xabc", fid=12345)
    assert cast_id.hash == "0xabc"
    assert cast_id.fid == 12345
