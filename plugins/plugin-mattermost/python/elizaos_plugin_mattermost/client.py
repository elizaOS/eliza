from __future__ import annotations

import logging
from typing import Any

import httpx

from elizaos_plugin_mattermost.types import (
    MattermostChannel,
    MattermostFileInfo,
    MattermostPost,
    MattermostUser,
)

logger = logging.getLogger(__name__)


def normalize_base_url(url: str | None) -> str | None:
    """Normalizes the base URL by removing trailing slashes and /api/v4 suffix."""
    if not url:
        return None
    trimmed = url.strip()
    if not trimmed:
        return None
    # Remove trailing slashes
    normalized = trimmed.rstrip("/")
    # Remove /api/v4 suffix if present
    if normalized.lower().endswith("/api/v4"):
        normalized = normalized[:-7]
    return normalized


class MattermostClient:
    """HTTP client for Mattermost REST API."""

    def __init__(self, base_url: str, bot_token: str) -> None:
        self.base_url = normalize_base_url(base_url) or ""
        self.api_base_url = f"{self.base_url}/api/v4"
        self.token = bot_token.strip()
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    def _build_url(self, path: str) -> str:
        """Build the full API URL for a given path."""
        suffix = path if path.startswith("/") else f"/{path}"
        return f"{self.api_base_url}{suffix}"

    async def _request(
        self,
        method: str,
        path: str,
        json: Any | None = None,
        **kwargs: Any,
    ) -> Any:
        """Make an authenticated request."""
        url = self._build_url(path)
        response = await self._client.request(method, url, json=json, **kwargs)
        if not response.is_success:
            error_text = await self._read_error(response)
            raise Exception(f"Mattermost API {response.status_code}: {error_text}")
        return response.json()

    async def _read_error(self, response: httpx.Response) -> str:
        """Read error message from response."""
        try:
            data = response.json()
            if isinstance(data, dict):
                if message := data.get("message"):
                    return str(message)
                if detailed := data.get("detailed_error"):
                    return str(detailed)
            return str(data)
        except Exception:
            return response.text

    # === User API ===

    async def get_me(self) -> MattermostUser:
        """Fetch the authenticated user's information."""
        data = await self._request("GET", "/users/me")
        return MattermostUser.model_validate(data)

    async def get_user(self, user_id: str) -> MattermostUser:
        """Fetch a user by their ID."""
        data = await self._request("GET", f"/users/{user_id}")
        return MattermostUser.model_validate(data)

    async def get_user_by_username(self, username: str) -> MattermostUser:
        """Fetch a user by their username."""
        data = await self._request("GET", f"/users/username/{username}")
        return MattermostUser.model_validate(data)

    async def get_users_by_ids(self, user_ids: list[str]) -> list[MattermostUser]:
        """Fetch multiple users by their IDs."""
        data = await self._request("POST", "/users/ids", json=user_ids)
        return [MattermostUser.model_validate(u) for u in data]

    # === Channel API ===

    async def get_channel(self, channel_id: str) -> MattermostChannel:
        """Fetch a channel by its ID."""
        data = await self._request("GET", f"/channels/{channel_id}")
        return MattermostChannel.model_validate(data)

    async def create_direct_channel(self, user_ids: list[str]) -> MattermostChannel:
        """Create a direct message channel between users."""
        data = await self._request("POST", "/channels/direct", json=user_ids)
        return MattermostChannel.model_validate(data)

    async def create_group_channel(self, user_ids: list[str]) -> MattermostChannel:
        """Create a group message channel between users."""
        data = await self._request("POST", "/channels/group", json=user_ids)
        return MattermostChannel.model_validate(data)

    # === Post API ===

    async def create_post(
        self,
        channel_id: str,
        message: str,
        root_id: str | None = None,
        file_ids: list[str] | None = None,
        props: dict[str, Any] | None = None,
    ) -> MattermostPost:
        """Create a post (message) in a channel."""
        payload: dict[str, Any] = {
            "channel_id": channel_id,
            "message": message,
        }
        if root_id:
            payload["root_id"] = root_id
        if file_ids:
            payload["file_ids"] = file_ids
        if props:
            payload["props"] = props
        data = await self._request("POST", "/posts", json=payload)
        return MattermostPost.model_validate(data)

    async def update_post(self, post_id: str, message: str) -> MattermostPost:
        """Update a post's message."""
        data = await self._request("PUT", f"/posts/{post_id}", json={"message": message})
        return MattermostPost.model_validate(data)

    async def delete_post(self, post_id: str) -> None:
        """Delete a post."""
        await self._request("DELETE", f"/posts/{post_id}")

    async def get_post(self, post_id: str) -> MattermostPost:
        """Get a post by its ID."""
        data = await self._request("GET", f"/posts/{post_id}")
        return MattermostPost.model_validate(data)

    async def get_post_thread(self, post_id: str) -> dict[str, Any]:
        """Get a post thread."""
        return await self._request("GET", f"/posts/{post_id}/thread")

    # === Typing API ===

    async def send_typing(self, channel_id: str, parent_id: str | None = None) -> None:
        """Send a typing indicator."""
        payload: dict[str, str] = {"channel_id": channel_id}
        if parent_id:
            payload["parent_id"] = parent_id
        await self._request("POST", "/users/me/typing", json=payload)

    # === File API ===

    async def get_file_info(self, file_id: str) -> MattermostFileInfo:
        """Get file info by ID."""
        data = await self._request("GET", f"/files/{file_id}/info")
        return MattermostFileInfo.model_validate(data)

    def websocket_url(self) -> str:
        """Returns the WebSocket URL for real-time events."""
        ws_base = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        return f"{ws_base}/api/v4/websocket"


def create_mattermost_client(base_url: str, bot_token: str) -> MattermostClient:
    """Create a Mattermost client instance."""
    normalized = normalize_base_url(base_url)
    if not normalized:
        raise ValueError("Mattermost base_url is required")
    return MattermostClient(normalized, bot_token)
