"""Moltbook service - HTTP client for the Moltbook API."""

import logging
from typing import Protocol

import httpx

from elizaos_plugin_moltbook.constants import CONTENT_LIMITS, MOLTBOOK_SERVICE_NAME, URLS
from elizaos_plugin_moltbook.types import (
    MoltbookAPIError,
    MoltbookAuthenticationError,
    MoltbookCommentData,
    MoltbookConfig,
    MoltbookConfigurationError,
    MoltbookContentTooLongError,
    MoltbookPostData,
    MoltbookResult,
    MoltbookSubmoltData,
    PostWithComments,
    moltbook_failure,
    moltbook_success,
)

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    def get_setting(self, key: str) -> str | None: ...


class MoltbookService:
    """MoltbookService - Social engagement service for the Moltbook platform.

    Enables agents to post, browse, and comment on Moltbook (Reddit for AI agents).
    """

    service_type = MOLTBOOK_SERVICE_NAME
    capability_description = (
        "The agent can post, browse, and comment on Moltbook"
        " - a Reddit-style social platform for AI agents"
    )

    def __init__(self, runtime: RuntimeProtocol) -> None:
        agent_name = (
            runtime.get_setting("MOLTBOOK_AGENT_NAME")
            or runtime.get_setting("CHARACTER_NAME")
            or "Agent"
        )

        if not agent_name.strip():
            raise MoltbookConfigurationError("Agent name cannot be empty")

        moltbook_token = runtime.get_setting("MOLTBOOK_TOKEN")

        autonomous_str = runtime.get_setting("MOLTBOOK_AUTONOMOUS_MODE")
        autonomous_mode = autonomous_str in ("true", "1") if autonomous_str else False

        interval_str = runtime.get_setting("MOLTBOOK_AUTONOMY_INTERVAL_MS")
        autonomy_interval_ms = int(interval_str) if interval_str else None

        max_steps_str = runtime.get_setting("MOLTBOOK_AUTONOMY_MAX_STEPS")
        autonomy_max_steps = int(max_steps_str) if max_steps_str else None

        self.config = MoltbookConfig(
            agent_name=agent_name,
            moltbook_token=moltbook_token,
            autonomous_mode=autonomous_mode,
            autonomy_interval_ms=autonomy_interval_ms,
            autonomy_max_steps=autonomy_max_steps,
        )

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if moltbook_token:
            headers["Authorization"] = f"Bearer {moltbook_token}"

        self._client = httpx.AsyncClient(
            base_url=URLS["moltbook"],
            headers=headers,
            timeout=30.0,
        )

        self._autonomy_running = False

    @classmethod
    async def start(cls, runtime: RuntimeProtocol) -> "MoltbookService":
        """Create and start the service."""
        service = cls(runtime)
        logger.info("Moltbook service started for %s", service.config.agent_name)
        logger.info("Moltbook API: %s", URLS["moltbook"])
        logger.info(
            "Token configured: %s",
            "yes" if service.config.moltbook_token else "no",
        )
        return service

    async def stop(self) -> None:
        """Stop the service."""
        self._autonomy_running = False
        await self._client.aclose()
        logger.info("Moltbook service stopped")

    def is_autonomy_running(self) -> bool:
        """Check if autonomy loop is running."""
        return self._autonomy_running

    # ==================== Post ====================

    async def moltbook_post(self, submolt: str, title: str, content: str) -> str:
        """Post to Moltbook. Returns post ID."""
        if not self.config.moltbook_token:
            raise MoltbookAuthenticationError("MOLTBOOK_TOKEN not set - cannot create posts")

        if len(title) > CONTENT_LIMITS["max_title_length"]:
            raise MoltbookContentTooLongError(
                f"Title exceeds maximum length of {CONTENT_LIMITS['max_title_length']} characters"
            )

        if len(content) > CONTENT_LIMITS["max_content_length"]:
            raise MoltbookContentTooLongError(
                f"Content exceeds maximum length of {CONTENT_LIMITS['max_content_length']}"
                " characters"
            )

        response = await self._client.post(
            "/posts",
            json={"submolt": submolt, "title": title, "content": content},
        )

        data = response.json()

        if response.status_code >= 400:
            error_msg = data.get("error", str(data))
            raise MoltbookAPIError(error_msg, status=response.status_code)

        post_id: str = data.get("post", {}).get("id", "success")
        logger.info("Posted to Moltbook: %s in r/%s", title, submolt)
        return post_id

    # ==================== Browse ====================

    async def moltbook_browse(
        self, submolt: str | None = None, sort: str = "hot"
    ) -> MoltbookResult:
        """Browse Moltbook posts. Returns MoltbookResult to distinguish empty from error."""
        try:
            if submolt:
                url = (
                    f"/submolts/{submolt}/feed"
                    f"?sort={sort}&limit={CONTENT_LIMITS['default_browse_limit']}"
                )
            else:
                url = f"/posts?sort={sort}&limit={CONTENT_LIMITS['default_browse_limit']}"

            response = await self._client.get(url)

            if response.status_code >= 400:
                error_text = response.text[:100]
                return moltbook_failure(
                    f"API returned {response.status_code}: {error_text}"
                )

            data = response.json()
            posts: list[MoltbookPostData] = data.get("posts", [])
            return moltbook_success(posts)

        except Exception as e:
            return moltbook_failure(str(e))

    # ==================== Comment ====================

    async def moltbook_comment(self, post_id: str, content: str) -> str:
        """Comment on a Moltbook post. Returns comment ID."""
        if not self.config.moltbook_token:
            raise MoltbookAuthenticationError("MOLTBOOK_TOKEN not set - cannot create comments")

        if len(content) > CONTENT_LIMITS["max_comment_length"]:
            raise MoltbookContentTooLongError(
                f"Comment exceeds maximum length of {CONTENT_LIMITS['max_comment_length']}"
                " characters"
            )

        response = await self._client.post(
            f"/posts/{post_id}/comments",
            json={"content": content},
        )

        data = response.json()

        if response.status_code >= 400:
            error_msg = data.get("error", str(data))
            raise MoltbookAPIError(error_msg, status=response.status_code)

        comment_id: str = data.get("id", "success")
        logger.info("Commented on Moltbook post %s", post_id)
        return comment_id

    # ==================== Reply ====================

    async def moltbook_reply(self, post_id: str, parent_id: str, content: str) -> str:
        """Reply to a Moltbook comment. Returns comment ID."""
        if not self.config.moltbook_token:
            raise MoltbookAuthenticationError("MOLTBOOK_TOKEN not set - cannot create replies")

        if len(content) > CONTENT_LIMITS["max_comment_length"]:
            raise MoltbookContentTooLongError(
                f"Reply exceeds maximum length of {CONTENT_LIMITS['max_comment_length']}"
                " characters"
            )

        response = await self._client.post(
            f"/posts/{post_id}/comments",
            json={"content": content, "parent_id": parent_id},
        )

        data = response.json()

        if response.status_code >= 400:
            error_msg = data.get("error", str(data))
            raise MoltbookAPIError(error_msg, status=response.status_code)

        comment_id: str = data.get("id", "success")
        logger.info("Replied to comment %s on post %s", parent_id, post_id)
        return comment_id

    # ==================== Read Post ====================

    async def moltbook_read_post(self, post_id: str) -> PostWithComments:
        """Read a Moltbook post with comments."""
        response = await self._client.get(f"/posts/{post_id}")

        data = response.json()

        if response.status_code >= 400:
            error_msg = data.get("error", str(data))
            raise MoltbookAPIError(error_msg, status=response.status_code)

        post: MoltbookPostData | None = data.get("post")
        if not post:
            raise MoltbookAPIError("Post not found", status=404)

        comments: list[MoltbookCommentData] = data.get("comments", [])

        return PostWithComments(post=post, comments=comments)

    # ==================== List Submolts ====================

    async def moltbook_list_submolts(self, sort: str = "popular") -> MoltbookResult:
        """List available submolts. Returns MoltbookResult."""
        try:
            response = await self._client.get(f"/submolts?sort={sort}&limit=20")

            if response.status_code >= 400:
                error_text = response.text[:100]
                return moltbook_failure(
                    f"API returned {response.status_code}: {error_text}"
                )

            data = response.json()
            submolts: list[MoltbookSubmoltData] = data.get("submolts", [])
            return moltbook_success(submolts)

        except Exception as e:
            return moltbook_failure(str(e))

    # ==================== Get Submolt ====================

    async def moltbook_get_submolt(self, submolt_name: str) -> MoltbookResult:
        """Get details about a specific submolt. Returns MoltbookResult."""
        try:
            response = await self._client.get(f"/submolts/{submolt_name}")

            if response.status_code == 404:
                # Not found is a valid result, not an error
                return moltbook_success(None)

            if response.status_code >= 400:
                error_text = response.text[:100]
                return moltbook_failure(
                    f"API returned {response.status_code}: {error_text}"
                )

            data = response.json()
            submolt: MoltbookSubmoltData | None = data.get("submolt")
            return moltbook_success(submolt)

        except Exception as e:
            return moltbook_failure(str(e))
