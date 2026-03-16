from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.error import ApiError, CastError, NetworkError, RateLimitError
from elizaos_plugin_farcaster.types import (
    Cast,
    CastEmbed,
    CastId,
    CastParent,
    CastStats,
    EmbedType,
    FidRequest,
    Profile,
)

NEYNAR_API_URL = "https://api.neynar.com/v2"


def _parse_embed_type(embed: dict[str, Any]) -> EmbedType:
    if "cast" in embed or "cast_id" in embed:
        return EmbedType.CAST
    if "url" in embed:
        url = embed["url"].lower()
        if any(ext in url for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp"]):
            return EmbedType.IMAGE
        if any(ext in url for ext in [".mp4", ".webm", ".mov"]):
            return EmbedType.VIDEO
        if any(ext in url for ext in [".mp3", ".wav", ".ogg"]):
            return EmbedType.AUDIO
        return EmbedType.URL
    return EmbedType.UNKNOWN


def _neynar_cast_to_cast(neynar_cast: dict[str, Any]) -> Cast:
    author = neynar_cast.get("author", {})

    profile = Profile(
        fid=author.get("fid", 0),
        name=author.get("display_name", "anon"),
        username=author.get("username", ""),
        pfp=author.get("pfp_url"),
        bio=author.get("profile", {}).get("bio", {}).get("text"),
    )

    embeds: list[CastEmbed] = []
    for embed_data in neynar_cast.get("embeds", []):
        embed = CastEmbed(
            type=_parse_embed_type(embed_data),
            url=embed_data.get("url", ""),
            cast_hash=embed_data.get("cast_id", {}).get("hash"),
        )
        embeds.append(embed)

    in_reply_to: CastParent | None = None
    parent_hash = neynar_cast.get("parent_hash")
    parent_author = neynar_cast.get("parent_author", {})
    if parent_hash and parent_author.get("fid"):
        in_reply_to = CastParent(hash=parent_hash, fid=parent_author["fid"])

    reactions = neynar_cast.get("reactions", {})
    stats = CastStats(
        recasts=reactions.get("recasts_count", 0),
        replies=neynar_cast.get("replies", {}).get("count", 0),
        likes=reactions.get("likes_count", 0),
    )

    timestamp_str = neynar_cast.get("timestamp", "")
    try:
        timestamp = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        timestamp = datetime.now()

    return Cast(
        hash=neynar_cast.get("hash", ""),
        author_fid=author.get("fid", 0),
        text=neynar_cast.get("text", ""),
        profile=profile,
        timestamp=timestamp,
        thread_id=neynar_cast.get("thread_hash"),
        in_reply_to=in_reply_to,
        stats=stats,
        embeds=embeds,
    )


def _split_post_content(content: str, max_length: int = 320) -> list[str]:
    paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]
    posts: list[str] = []
    current_cast = ""

    for paragraph in paragraphs:
        test_cast = f"{current_cast}\n\n{paragraph}".strip() if current_cast else paragraph

        if len(test_cast) <= max_length:
            current_cast = test_cast
        else:
            if current_cast:
                posts.append(current_cast)
            if len(paragraph) <= max_length:
                current_cast = paragraph
            else:
                chunks = _split_paragraph(paragraph, max_length)
                posts.extend(chunks[:-1])
                current_cast = chunks[-1] if chunks else ""

    if current_cast:
        posts.append(current_cast)

    return posts


def _split_paragraph(paragraph: str, max_length: int) -> list[str]:
    import re

    sentences = re.findall(r"[^.!?]+[.!?]+|[^.!?]+$", paragraph)
    if not sentences:
        sentences = [paragraph]

    chunks: list[str] = []
    current_chunk = ""

    for sentence in sentences:
        test_chunk = f"{current_chunk} {sentence}".strip() if current_chunk else sentence

        if len(test_chunk) <= max_length:
            current_chunk = test_chunk
        else:
            if current_chunk:
                chunks.append(current_chunk)
            if len(sentence) <= max_length:
                current_chunk = sentence
            else:
                # Split by words
                words = sentence.split()
                current_chunk = ""
                for word in words:
                    test_word = f"{current_chunk} {word}".strip() if current_chunk else word
                    if len(test_word) <= max_length:
                        current_chunk = test_word
                    else:
                        if current_chunk:
                            chunks.append(current_chunk)
                        # Handle words longer than max_length by splitting by character
                        if len(word) > max_length:
                            word_chunks = _split_by_length(word, max_length)
                            chunks.extend(word_chunks[:-1])
                            current_chunk = word_chunks[-1] if word_chunks else ""
                        else:
                            current_chunk = word

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def _split_by_length(text: str, max_length: int) -> list[str]:
    """Split text into chunks of max_length characters."""
    return [text[i : i + max_length] for i in range(0, len(text), max_length)]


class FarcasterClient:
    def __init__(self, config: FarcasterConfig) -> None:
        self._config = config
        self._http_client = httpx.AsyncClient(
            base_url=NEYNAR_API_URL,
            headers={
                "api_key": config.neynar_api_key,
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )
        self._profile_cache: dict[int, Profile] = {}
        self._cast_cache: dict[str, Cast] = {}

    async def close(self) -> None:
        await self._http_client.aclose()

    async def __aenter__(self) -> FarcasterClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def _make_request(
        self,
        method: str,
        endpoint: str,
        params: dict[str, Any] | None = None,
        json_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            response = await self._http_client.request(
                method=method,
                url=endpoint,
                params=params,
                json=json_data,
            )

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                raise RateLimitError(retry_after=int(retry_after) if retry_after else None)

            if response.status_code >= 400:
                error_data = response.json() if response.content else {}
                raise ApiError(
                    message=error_data.get("message", f"API error: {response.status_code}"),
                    status_code=response.status_code,
                    error_code=error_data.get("code"),
                )

            return response.json()  # type: ignore[no-any-return]

        except httpx.RequestError as e:
            raise NetworkError(f"Network error: {e}") from e

    async def send_cast(
        self,
        text: str,
        in_reply_to: CastId | None = None,
    ) -> list[Cast]:
        text = text.strip()
        if not text:
            return []

        if self._config.dry_run:
            fake_cast = Cast(
                hash="dry_run_hash",
                author_fid=self._config.fid,
                text=text,
                profile=Profile(
                    fid=self._config.fid,
                    name="Dry Run",
                    username="dry_run",
                ),
                timestamp=datetime.now(),
            )
            return [fake_cast]

        chunks = _split_post_content(text, self._config.max_cast_length)
        sent: list[Cast] = []

        for chunk in chunks:
            cast = await self._publish_cast(chunk, in_reply_to)
            sent.append(cast)

        return sent

    async def _publish_cast(
        self,
        text: str,
        parent_cast_id: CastId | None = None,
    ) -> Cast:
        payload: dict[str, Any] = {
            "signer_uuid": self._config.signer_uuid,
            "text": text,
        }

        if parent_cast_id:
            payload["parent"] = parent_cast_id.hash

        try:
            result = await self._make_request(
                "POST",
                "/farcaster/cast",
                json_data=payload,
            )

            if not result.get("success"):
                raise CastError(f"Failed to publish cast: {text[:50]}...")

            cast_hash = result.get("cast", {}).get("hash")
            if cast_hash:
                return await self.get_cast(cast_hash)

            return Cast(
                hash=cast_hash or "",
                author_fid=self._config.fid,
                text=text,
                profile=Profile(
                    fid=self._config.fid,
                    name="",
                    username="",
                ),
                timestamp=datetime.now(),
            )

        except ApiError:
            raise
        except Exception as e:
            raise CastError(f"Error publishing cast: {e}") from e

    async def get_cast(self, cast_hash: str) -> Cast:
        if cast_hash in self._cast_cache:
            return self._cast_cache[cast_hash]

        result = await self._make_request(
            "GET",
            "/farcaster/cast",
            params={"identifier": cast_hash, "type": "hash"},
        )

        cast = _neynar_cast_to_cast(result.get("cast", {}))
        self._cast_cache[cast_hash] = cast

        return cast

    async def get_mentions(self, request: FidRequest) -> list[Cast]:
        result = await self._make_request(
            "GET",
            "/farcaster/notifications",
            params={
                "fid": request.fid,
                "type": "mentions,replies",
                "limit": request.page_size,
            },
        )

        mentions: list[Cast] = []
        for notification in result.get("notifications", []):
            neynar_cast = notification.get("cast")
            if neynar_cast:
                mentions.append(_neynar_cast_to_cast(neynar_cast))

        return mentions

    async def get_profile(self, fid: int) -> Profile:
        """
        Get a user's profile by FID.

        Args:
            fid: The Farcaster ID.

        Returns:
            The user profile.
        """
        # Check cache
        if fid in self._profile_cache:
            return self._profile_cache[fid]

        result = await self._make_request(
            "GET",
            "/farcaster/user/bulk",
            params={"fids": str(fid)},
        )

        users = result.get("users", [])
        if not users:
            raise ApiError(f"User not found: {fid}")

        user = users[0]
        profile = Profile(
            fid=fid,
            name=user.get("display_name", ""),
            username=user.get("username", ""),
            bio=user.get("profile", {}).get("bio", {}).get("text"),
            pfp=user.get("pfp_url"),
        )

        self._profile_cache[fid] = profile
        return profile

    async def get_timeline(
        self,
        request: FidRequest,
    ) -> tuple[list[Cast], str | None]:
        result = await self._make_request(
            "GET",
            "/farcaster/feed/user/casts",
            params={
                "fid": request.fid,
                "limit": request.page_size,
            },
        )

        timeline: list[Cast] = []
        for neynar_cast in result.get("casts", []):
            cast = _neynar_cast_to_cast(neynar_cast)
            self._cast_cache[cast.hash] = cast
            timeline.append(cast)

        next_cursor = result.get("next", {}).get("cursor")
        return timeline, next_cursor

    def clear_cache(self) -> None:
        self._profile_cache.clear()
        self._cast_cache.clear()
