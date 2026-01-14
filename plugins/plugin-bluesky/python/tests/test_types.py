from elizaos_plugin_bluesky.types import (
    BlueSkyPost,
    BlueSkyProfile,
    BlueSkySession,
    NotificationReason,
    PostRecord,
)


class TestBlueSkyProfile:
    def test_create_profile_minimal(self) -> None:
        profile = BlueSkyProfile(
            did="did:plc:test123",
            handle="test.bsky.social",
        )
        assert profile.did == "did:plc:test123"
        assert profile.handle == "test.bsky.social"
        assert profile.display_name is None
        assert profile.description is None

    def test_create_profile_full(self) -> None:
        profile = BlueSkyProfile(
            did="did:plc:test123",
            handle="test.bsky.social",
            display_name="Test User",
            description="A test user",
            avatar="https://example.com/avatar.jpg",
            followers_count=100,
            follows_count=50,
            posts_count=25,
        )
        assert profile.display_name == "Test User"
        assert profile.followers_count == 100


class TestBlueSkyPost:
    def test_create_post(self) -> None:
        post = BlueSkyPost(
            uri="at://did:plc:test/app.bsky.feed.post/abc123",
            cid="bafytest",
            author=BlueSkyProfile(
                did="did:plc:test",
                handle="test.bsky.social",
            ),
            record=PostRecord(
                type_field="app.bsky.feed.post",
                text="Hello world!",
                created_at="2024-01-01T00:00:00Z",
            ),
            indexed_at="2024-01-01T00:00:00Z",
        )
        assert post.uri == "at://did:plc:test/app.bsky.feed.post/abc123"
        assert post.record.text == "Hello world!"


class TestBlueSkySession:
    def test_create_session(self) -> None:
        session = BlueSkySession(
            did="did:plc:test",
            handle="test.bsky.social",
            access_jwt="access-token",
            refresh_jwt="refresh-token",
        )
        assert session.did == "did:plc:test"
        assert session.handle == "test.bsky.social"
        assert session.access_jwt == "access-token"


class TestNotificationReason:
    def test_notification_reasons(self) -> None:
        assert NotificationReason.MENTION.value == "mention"
        assert NotificationReason.REPLY.value == "reply"
        assert NotificationReason.FOLLOW.value == "follow"
        assert NotificationReason.LIKE.value == "like"
        assert NotificationReason.REPOST.value == "repost"
        assert NotificationReason.QUOTE.value == "quote"
