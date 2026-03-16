"""Tests for Instagram types."""

from datetime import datetime

from elizaos_plugin_instagram.types import (
    InstagramComment,
    InstagramEventType,
    InstagramMedia,
    InstagramMediaType,
    InstagramMessage,
    InstagramThread,
    InstagramUser,
)


class TestInstagramEventType:
    def test_event_types(self) -> None:
        assert InstagramEventType.MESSAGE_RECEIVED == "INSTAGRAM_MESSAGE_RECEIVED"
        assert InstagramEventType.MESSAGE_SENT == "INSTAGRAM_MESSAGE_SENT"
        assert InstagramEventType.COMMENT_RECEIVED == "INSTAGRAM_COMMENT_RECEIVED"
        assert InstagramEventType.LIKE_RECEIVED == "INSTAGRAM_LIKE_RECEIVED"
        assert InstagramEventType.FOLLOW_RECEIVED == "INSTAGRAM_FOLLOW_RECEIVED"


class TestInstagramMediaType:
    def test_media_types(self) -> None:
        assert InstagramMediaType.PHOTO == "photo"
        assert InstagramMediaType.VIDEO == "video"
        assert InstagramMediaType.CAROUSEL == "carousel"
        assert InstagramMediaType.REEL == "reel"
        assert InstagramMediaType.STORY == "story"


class TestInstagramUser:
    def test_user_creation(self) -> None:
        user = InstagramUser(
            pk=12345,
            username="testuser",
            full_name="Test User",
            profile_pic_url="https://example.com/pic.jpg",
            is_private=False,
            is_verified=True,
            follower_count=1000,
            following_count=500,
        )

        assert user.pk == 12345
        assert user.username == "testuser"
        assert user.full_name == "Test User"
        assert user.is_verified
        assert not user.is_private

    def test_user_minimal(self) -> None:
        user = InstagramUser(pk=12345, username="testuser")

        assert user.pk == 12345
        assert user.full_name is None
        assert user.follower_count is None


class TestInstagramMedia:
    def test_photo_media(self) -> None:
        media = InstagramMedia(
            pk=67890,
            media_type=InstagramMediaType.PHOTO,
            caption="Test caption",
            url="https://example.com/photo.jpg",
            like_count=100,
            comment_count=10,
        )

        assert media.pk == 67890
        assert media.media_type == InstagramMediaType.PHOTO
        assert media.caption == "Test caption"
        assert media.like_count == 100

    def test_video_media(self) -> None:
        media = InstagramMedia(
            pk=67890,
            media_type=InstagramMediaType.VIDEO,
            url="https://example.com/video.mp4",
            thumbnail_url="https://example.com/thumb.jpg",
        )

        assert media.media_type == InstagramMediaType.VIDEO
        assert media.thumbnail_url is not None


class TestInstagramMessage:
    def test_message_creation(self) -> None:
        user = InstagramUser(pk=12345, username="sender")
        now = datetime.now()

        message = InstagramMessage(
            id="msg123",
            thread_id="thread456",
            text="Hello world",
            timestamp=now,
            user=user,
        )

        assert message.id == "msg123"
        assert message.thread_id == "thread456"
        assert message.text == "Hello world"
        assert message.user.username == "sender"
        assert not message.is_seen

    def test_message_with_media(self) -> None:
        user = InstagramUser(pk=12345, username="sender")
        media = InstagramMedia(pk=67890, media_type=InstagramMediaType.PHOTO)
        now = datetime.now()

        message = InstagramMessage(
            id="msg123",
            thread_id="thread456",
            timestamp=now,
            user=user,
            media=media,
        )

        assert message.media is not None
        assert message.media.media_type == InstagramMediaType.PHOTO


class TestInstagramComment:
    def test_comment_creation(self) -> None:
        user = InstagramUser(pk=12345, username="commenter")
        now = datetime.now()

        comment = InstagramComment(
            pk=11111,
            text="Great post!",
            created_at=now,
            user=user,
            media_pk=67890,
        )

        assert comment.pk == 11111
        assert comment.text == "Great post!"
        assert comment.user.username == "commenter"
        assert comment.reply_to_pk is None

    def test_reply_comment(self) -> None:
        user = InstagramUser(pk=12345, username="replier")
        now = datetime.now()

        comment = InstagramComment(
            pk=22222,
            text="Thanks!",
            created_at=now,
            user=user,
            media_pk=67890,
            reply_to_pk=11111,
        )

        assert comment.reply_to_pk == 11111


class TestInstagramThread:
    def test_thread_creation(self) -> None:
        users = [
            InstagramUser(pk=12345, username="user1"),
            InstagramUser(pk=67890, username="user2"),
        ]
        now = datetime.now()

        thread = InstagramThread(
            id="thread123",
            users=users,
            last_activity_at=now,
            is_group=False,
        )

        assert thread.id == "thread123"
        assert len(thread.users) == 2
        assert not thread.is_group

    def test_group_thread(self) -> None:
        users = [
            InstagramUser(pk=1, username="user1"),
            InstagramUser(pk=2, username="user2"),
            InstagramUser(pk=3, username="user3"),
        ]

        thread = InstagramThread(
            id="group123",
            users=users,
            is_group=True,
            thread_title="Group Chat",
        )

        assert thread.is_group
        assert thread.thread_title == "Group Chat"
