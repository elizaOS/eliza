"""Tests for BlueSky service and client."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from elizaos_plugin_bluesky.client import BlueSkyClient
from elizaos_plugin_bluesky.config import BlueSkyConfig
from elizaos_plugin_bluesky.errors import AuthenticationError, NetworkError, RateLimitError
from elizaos_plugin_bluesky.service import BlueSkyService
from elizaos_plugin_bluesky.types import (
    CreatePostContent,
    CreatePostRequest,
    PostRecord,
)


@pytest.fixture()
def config() -> BlueSkyConfig:
    return BlueSkyConfig(handle="test.bsky.social", password="test-password")


@pytest.fixture()
def dry_run_config() -> BlueSkyConfig:
    return BlueSkyConfig(handle="test.bsky.social", password="test-password", dry_run=True)


@pytest.fixture()
def client(config: BlueSkyConfig) -> BlueSkyClient:
    return BlueSkyClient(config)


def _mock_response(
    status_code: int = 200,
    json_data: dict[str, object] | None = None,
    text: str = "",
) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.text = text
    resp.json.return_value = json_data or {}
    return resp


# ── BlueSkyService tests ─────────────────────────────────────────


class TestBlueSkyService:
    def test_service_type(self) -> None:
        assert BlueSkyService.service_type == "bluesky"

    def test_capability_description(self, client: BlueSkyClient) -> None:
        svc = BlueSkyService(client)
        assert svc.capability_description == "Send and receive messages on BlueSky"

    def test_creation_with_client(self, client: BlueSkyClient) -> None:
        svc = BlueSkyService(client)
        assert svc.client is client

    def test_client_property_returns_client(self, client: BlueSkyClient) -> None:
        svc = BlueSkyService(client)
        assert isinstance(svc.client, BlueSkyClient)

    def test_from_env_creates_service(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BLUESKY_HANDLE", "env.bsky.social")
        monkeypatch.setenv("BLUESKY_PASSWORD", "env-pass")
        svc = BlueSkyService.from_env()
        assert svc.client.config.handle == "env.bsky.social"

    async def test_stop_closes_client(self, client: BlueSkyClient) -> None:
        svc = BlueSkyService(client)
        client._http = AsyncMock()
        await svc.stop()
        client._http.aclose.assert_awaited_once()


# ── BlueSkyClient authentication tests ───────────────────────────


class TestBlueSkyClientAuthenticate:
    async def test_authenticate_success(self, client: BlueSkyClient) -> None:
        resp = _mock_response(
            200,
            {
                "did": "did:plc:test123",
                "handle": "test.bsky.social",
                "email": "test@example.com",
                "accessJwt": "access-token",
                "refreshJwt": "refresh-token",
            },
        )
        mock_http = AsyncMock()
        mock_http.post.return_value = resp
        client._http = mock_http

        session = await client.authenticate()

        assert session.did == "did:plc:test123"
        assert session.handle == "test.bsky.social"
        assert session.access_jwt == "access-token"

    async def test_authenticate_failure_raises(self, client: BlueSkyClient) -> None:
        resp = _mock_response(401, text="Unauthorized")
        mock_http = AsyncMock()
        mock_http.post.return_value = resp
        client._http = mock_http

        with pytest.raises(AuthenticationError, match="Authentication failed"):
            await client.authenticate()

    async def test_authenticate_network_error_raises(self, client: BlueSkyClient) -> None:
        mock_http = AsyncMock()
        mock_http.post.side_effect = httpx.RequestError("Connection refused")
        client._http = mock_http

        with pytest.raises(NetworkError, match="Network error"):
            await client.authenticate()


# ── BlueSkyClient post tests ─────────────────────────────────────


class TestBlueSkyClientPosts:
    async def test_send_post_dry_run_returns_mock(self, dry_run_config: BlueSkyConfig) -> None:
        dry_client = BlueSkyClient(dry_run_config)
        request = CreatePostRequest(content=CreatePostContent(text="Dry run post"))
        post = await dry_client.send_post(request)

        assert post.record.text == "Dry run post"
        assert post.uri.startswith("mock://")

    async def test_send_post_without_session_raises(self, config: BlueSkyConfig) -> None:
        fresh_client = BlueSkyClient(config)
        request = CreatePostRequest(content=CreatePostContent(text="Real post"))

        with pytest.raises(ValueError, match="Session not initialized"):
            await fresh_client.send_post(request)


# ── BlueSkyClient._request tests ─────────────────────────────────


class TestBlueSkyClientRequest:
    async def test_request_unauthenticated_raises(self, client: BlueSkyClient) -> None:
        with pytest.raises(AuthenticationError, match="Not authenticated"):
            await client._request("GET", "some.endpoint")

    async def test_request_rate_limit_raises(self, client: BlueSkyClient) -> None:
        from elizaos_plugin_bluesky.types import BlueSkySession

        client._session = BlueSkySession(
            did="did:plc:test",
            handle="test.bsky.social",
            access_jwt="token",
            refresh_jwt="refresh",
        )
        resp = _mock_response(429)
        mock_http = AsyncMock()
        mock_http.get.return_value = resp
        client._http = mock_http

        with pytest.raises(RateLimitError):
            await client._request("GET", "some.endpoint")

    async def test_request_timeout_raises_network_error(self, client: BlueSkyClient) -> None:
        from elizaos_plugin_bluesky.types import BlueSkySession

        client._session = BlueSkySession(
            did="did:plc:test",
            handle="test.bsky.social",
            access_jwt="token",
            refresh_jwt="refresh",
        )
        mock_http = AsyncMock()
        mock_http.get.side_effect = httpx.TimeoutException("Request timed out")
        client._http = mock_http

        with pytest.raises(NetworkError, match="Timeout"):
            await client._request("GET", "some.endpoint")


# ── BlueSkyClient._map_post tests ────────────────────────────────


class TestBlueSkyClientMapPost:
    def test_map_post_full_data(self, client: BlueSkyClient) -> None:
        data: dict[str, object] = {
            "uri": "at://did:plc:test/app.bsky.feed.post/abc",
            "cid": "bafytest",
            "author": {
                "did": "did:plc:test",
                "handle": "test.bsky.social",
                "displayName": "Test User",
            },
            "record": {"text": "Hello world", "createdAt": "2024-01-01T00:00:00Z"},
            "replyCount": 5,
            "repostCount": 3,
            "likeCount": 10,
            "indexedAt": "2024-01-01T00:00:00Z",
        }
        post = client._map_post(data)

        assert post.uri == "at://did:plc:test/app.bsky.feed.post/abc"
        assert post.author.handle == "test.bsky.social"
        assert post.author.display_name == "Test User"
        assert post.record.text == "Hello world"
        assert post.reply_count == 5

    def test_map_post_minimal_data(self, client: BlueSkyClient) -> None:
        data: dict[str, object] = {
            "uri": "at://test",
            "cid": "cid-1",
            "author": {"did": "did:plc:x", "handle": "x.bsky.social"},
            "record": {"text": ""},
            "indexedAt": "",
        }
        post = client._map_post(data)

        assert post.cid == "cid-1"
        assert post.record.text == ""
        assert post.reply_count is None
        assert post.like_count is None
