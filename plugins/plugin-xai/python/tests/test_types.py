"""Tests for xAI plugin type definitions."""

from datetime import datetime

import pytest

from elizaos_plugin_xai.types import (
    ActionResponse,
    AuthMode,
    Mention,
    Photo,
    PlaceData,
    PollData,
    PollOption,
    Post,
    PostCreateResult,
    PostMetrics,
    Profile,
    QueryPostsResponse,
    QueryProfilesResponse,
    SearchMode,
    TwitterConfig,
    Video,
)


class TestAuthMode:
    """Tests for AuthMode enum."""

    def test_env(self) -> None:
        assert AuthMode.ENV == "env"

    def test_oauth(self) -> None:
        assert AuthMode.OAUTH == "oauth"

    def test_bearer(self) -> None:
        assert AuthMode.BEARER == "bearer"


class TestSearchMode:
    """Tests for SearchMode enum."""

    def test_all_modes(self) -> None:
        assert SearchMode.TOP == "top"
        assert SearchMode.LATEST == "latest"
        assert SearchMode.PHOTOS == "photos"
        assert SearchMode.VIDEOS == "videos"


class TestTwitterConfig:
    """Tests for TwitterConfig."""

    def test_defaults(self) -> None:
        config = TwitterConfig()
        assert config.auth_mode == AuthMode.ENV
        assert config.max_post_length == 280
        assert config.retry_limit == 5
        assert config.timeout == 30.0
        assert config.dry_run is False
        assert config.enable_post is False
        assert config.enable_replies is True
        assert config.enable_actions is False

    def test_custom_values(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.BEARER,
            bearer_token="my-token",
            dry_run=True,
            enable_post=True,
            max_post_length=500,
        )
        assert config.auth_mode == AuthMode.BEARER
        assert config.bearer_token == "my-token"
        assert config.dry_run is True
        assert config.enable_post is True
        assert config.max_post_length == 500

    def test_validate_credentials_env_mode_missing(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.ENV)
        with pytest.raises(ValueError, match="Missing credentials"):
            config.validate_credentials()

    def test_validate_credentials_env_mode_valid(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.ENV,
            api_key="key",
            api_secret="secret",
            access_token="token",
            access_token_secret="token_secret",
        )
        config.validate_credentials()  # Should not raise

    def test_validate_credentials_bearer_mode_missing(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.BEARER)
        with pytest.raises(ValueError, match="bearer_token"):
            config.validate_credentials()

    def test_validate_credentials_bearer_mode_valid(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.BEARER, bearer_token="token")
        config.validate_credentials()  # Should not raise

    def test_validate_credentials_oauth_mode_missing(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.OAUTH)
        with pytest.raises(ValueError, match="client_id"):
            config.validate_credentials()

    def test_validate_credentials_oauth_mode_valid(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.OAUTH,
            client_id="cid",
            redirect_uri="https://example.com/cb",
        )
        config.validate_credentials()  # Should not raise


class TestPhoto:
    """Tests for Photo."""

    def test_construction(self) -> None:
        photo = Photo(id="p1", url="https://img.com/1.jpg", alt_text="A cat")
        assert photo.id == "p1"
        assert photo.url == "https://img.com/1.jpg"
        assert photo.alt_text == "A cat"

    def test_optional_alt_text(self) -> None:
        photo = Photo(id="p2", url="https://img.com/2.jpg")
        assert photo.alt_text is None


class TestVideo:
    """Tests for Video."""

    def test_construction(self) -> None:
        video = Video(id="v1", preview="https://img.com/preview.jpg", url="https://vid.com/1.mp4")
        assert video.id == "v1"
        assert video.url == "https://vid.com/1.mp4"

    def test_optional_fields(self) -> None:
        video = Video(id="v2", preview="https://img.com/p.jpg")
        assert video.url is None
        assert video.duration_ms is None


class TestMention:
    """Tests for Mention."""

    def test_construction(self) -> None:
        mention = Mention(id="u1", username="alice", name="Alice")
        assert mention.id == "u1"
        assert mention.username == "alice"
        assert mention.name == "Alice"


class TestPollData:
    """Tests for PollData."""

    def test_construction(self) -> None:
        poll = PollData(
            id="poll1",
            duration_minutes=60,
            options=[
                PollOption(position=1, label="Yes", votes=10),
                PollOption(position=2, label="No", votes=5),
            ],
        )
        assert poll.id == "poll1"
        assert poll.duration_minutes == 60
        assert len(poll.options) == 2
        assert poll.options[0].label == "Yes"
        assert poll.options[0].votes == 10


class TestProfile:
    """Tests for Profile."""

    def test_construction(self) -> None:
        profile = Profile(id="u1", username="alice", name="Alice")
        assert profile.id == "u1"
        assert profile.username == "alice"
        assert profile.verified is False
        assert profile.followers_count == 0

    def test_full_profile(self) -> None:
        profile = Profile(
            id="u2",
            username="bob",
            name="Bob",
            description="Developer",
            location="NYC",
            verified=True,
            followers_count=1000,
            following_count=500,
            post_count=200,
        )
        assert profile.verified is True
        assert profile.followers_count == 1000
        assert profile.description == "Developer"


class TestPostMetrics:
    """Tests for PostMetrics."""

    def test_defaults(self) -> None:
        metrics = PostMetrics()
        assert metrics.like_count == 0
        assert metrics.repost_count == 0
        assert metrics.reply_count == 0
        assert metrics.quote_count == 0
        assert metrics.impression_count == 0
        assert metrics.bookmark_count == 0

    def test_custom_values(self) -> None:
        metrics = PostMetrics(like_count=42, repost_count=10, reply_count=5)
        assert metrics.like_count == 42
        assert metrics.repost_count == 10


class TestPlaceData:
    """Tests for PlaceData."""

    def test_construction(self) -> None:
        place = PlaceData(
            id="p1",
            name="San Francisco",
            full_name="San Francisco, CA",
            country="US",
            country_code="US",
            place_type="city",
        )
        assert place.name == "San Francisco"
        assert place.country_code == "US"

    def test_all_optional(self) -> None:
        place = PlaceData()
        assert place.id is None
        assert place.name is None


class TestPost:
    """Tests for Post."""

    def test_minimal_construction(self) -> None:
        post = Post(id="post1", text="Hello world")
        assert post.id == "post1"
        assert post.text == "Hello world"
        assert post.hashtags == []
        assert post.mentions == []
        assert post.photos == []
        assert post.is_reply is False
        assert post.is_repost is False

    def test_full_construction(self) -> None:
        post = Post(
            id="post2",
            text="Check this out!",
            author_id="author1",
            username="alice",
            name="Alice",
            metrics=PostMetrics(like_count=100),
            hashtags=["AI", "tech"],
            is_quote=True,
            quoted_id="original-post-id",
        )
        assert post.author_id == "author1"
        assert post.username == "alice"
        assert post.metrics.like_count == 100
        assert post.hashtags == ["AI", "tech"]
        assert post.is_quote is True

    def test_permanent_url_computed(self) -> None:
        post = Post(id="12345", text="Test")
        assert post.permanent_url == "https://x.com/i/status/12345"

    def test_timestamp_computed_from_created_at(self) -> None:
        dt = datetime(2025, 1, 1, 12, 0, 0)
        post = Post(id="p1", text="Test", created_at=dt)
        assert post.timestamp == int(dt.timestamp())

    def test_thread_default_empty(self) -> None:
        post = Post(id="p1", text="Thread")
        assert post.thread == []


class TestPostCreateResult:
    """Tests for PostCreateResult."""

    def test_construction(self) -> None:
        result = PostCreateResult(id="new-post-1", text="My post")
        assert result.id == "new-post-1"
        assert result.text == "My post"


class TestQueryPostsResponse:
    """Tests for QueryPostsResponse."""

    def test_construction(self) -> None:
        resp = QueryPostsResponse(
            posts=[Post(id="p1", text="Hello")],
            next_token="abc",
        )
        assert len(resp.posts) == 1
        assert resp.next_token == "abc"

    def test_empty(self) -> None:
        resp = QueryPostsResponse(posts=[])
        assert resp.posts == []
        assert resp.next_token is None


class TestQueryProfilesResponse:
    """Tests for QueryProfilesResponse."""

    def test_construction(self) -> None:
        resp = QueryProfilesResponse(
            profiles=[Profile(id="u1", username="alice", name="Alice")],
        )
        assert len(resp.profiles) == 1


class TestActionResponse:
    """Tests for ActionResponse."""

    def test_defaults(self) -> None:
        resp = ActionResponse()
        assert resp.like is False
        assert resp.repost is False
        assert resp.quote is False
        assert resp.reply is False

    def test_custom(self) -> None:
        resp = ActionResponse(like=True, reply=True)
        assert resp.like is True
        assert resp.reply is True
