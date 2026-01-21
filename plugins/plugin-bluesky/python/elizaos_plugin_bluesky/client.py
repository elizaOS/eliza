from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx

from elizaos_plugin_bluesky.config import BlueSkyConfig
from elizaos_plugin_bluesky.errors import (
    AuthenticationError,
    NetworkError,
    PostError,
    RateLimitError,
)
from elizaos_plugin_bluesky.types import (
    BLUESKY_CHAT_SERVICE_DID,
    BlueSkyConversation,
    BlueSkyMessage,
    BlueSkyNotification,
    BlueSkyPost,
    BlueSkyProfile,
    BlueSkySession,
    CreatePostRequest,
    NotificationReason,
    PostRecord,
    SendMessageRequest,
    TimelineFeedItem,
    TimelineRequest,
    TimelineResponse,
)

logger = logging.getLogger(__name__)


class BlueSkyClient:
    def __init__(self, config: BlueSkyConfig) -> None:
        self.config = config
        self._http = httpx.AsyncClient(timeout=30.0)
        self._session: BlueSkySession | None = None

    @property
    def session(self) -> BlueSkySession | None:
        return self._session

    async def close(self) -> None:
        await self._http.aclose()
        self._session = None

    async def __aenter__(self) -> BlueSkyClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def authenticate(self) -> BlueSkySession:
        try:
            response = await self._http.post(
                f"{self.config.service}/xrpc/com.atproto.server.createSession",
                json={"identifier": self.config.handle, "password": self.config.password},
            )
            if response.status_code != 200:
                raise AuthenticationError(f"Authentication failed: {response.text}")

            data = response.json()
            self._session = BlueSkySession(
                did=data["did"],
                handle=data["handle"],
                email=data.get("email"),
                access_jwt=data["accessJwt"],
                refresh_jwt=data["refreshJwt"],
            )
            logger.info("Authenticated with BlueSky", extra={"handle": self._session.handle})
            return self._session

        except httpx.RequestError as e:
            raise NetworkError(f"Network error: {e}") from e

    async def get_profile(self, handle: str) -> BlueSkyProfile:
        response = await self._request("GET", "app.bsky.actor.getProfile", params={"actor": handle})
        return BlueSkyProfile(
            did=response["did"],
            handle=response["handle"],
            display_name=response.get("displayName"),
            description=response.get("description"),
            avatar=response.get("avatar"),
            followers_count=response.get("followersCount"),
            follows_count=response.get("followsCount"),
            posts_count=response.get("postsCount"),
        )

    async def get_timeline(self, request: TimelineRequest) -> TimelineResponse:
        params: dict[str, str | int] = {"limit": request.limit}
        if request.algorithm:
            params["algorithm"] = request.algorithm
        if request.cursor:
            params["cursor"] = request.cursor

        response = await self._request("GET", "app.bsky.feed.getTimeline", params=params)
        return TimelineResponse(
            cursor=response.get("cursor"),
            feed=[
                TimelineFeedItem(post=self._map_post(item["post"]), reply=item.get("reply"))
                for item in response.get("feed", [])
            ],
        )

    async def send_post(self, request: CreatePostRequest) -> BlueSkyPost:
        if self.config.dry_run:
            logger.info("Dry run: would create post", extra={"text": request.content.text})
            return self._mock_post(request.content.text)

        record: dict[str, str | dict | list] = {
            "$type": "app.bsky.feed.post",
            "text": request.content.text,
            "createdAt": datetime.now(UTC).isoformat(),
        }
        if request.reply_to:
            record["reply"] = {
                "root": {"uri": request.reply_to.uri, "cid": request.reply_to.cid},
                "parent": {"uri": request.reply_to.uri, "cid": request.reply_to.cid},
            }

        if not self._session:
            raise ValueError("Session not initialized")
        response = await self._request(
            "POST",
            "com.atproto.repo.createRecord",
            json={"repo": self._session.did, "collection": "app.bsky.feed.post", "record": record},
        )

        thread = await self._request(
            "GET", "app.bsky.feed.getPostThread", params={"uri": response["uri"], "depth": 0}
        )
        if thread.get("thread", {}).get("$type") == "app.bsky.feed.defs#threadViewPost":
            return self._map_post(thread["thread"]["post"])
        raise PostError("Failed to retrieve created post", "create")

    async def delete_post(self, uri: str) -> None:
        if self.config.dry_run:
            logger.info("Dry run: would delete post", extra={"uri": uri})
            return
        if not self._session:
            raise ValueError("Session not initialized")
        rkey = uri.split("/")[-1]
        await self._request(
            "POST",
            "com.atproto.repo.deleteRecord",
            json={"repo": self._session.did, "collection": "app.bsky.feed.post", "rkey": rkey},
        )

    async def like_post(self, uri: str, cid: str) -> None:
        if self.config.dry_run:
            return
        if not self._session:
            raise ValueError("Session not initialized")
        await self._request(
            "POST",
            "com.atproto.repo.createRecord",
            json={
                "repo": self._session.did,
                "collection": "app.bsky.feed.like",
                "record": {
                    "$type": "app.bsky.feed.like",
                    "subject": {"uri": uri, "cid": cid},
                    "createdAt": datetime.now(UTC).isoformat(),
                },
            },
        )

    async def repost(self, uri: str, cid: str) -> None:
        if self.config.dry_run:
            return
        if not self._session:
            raise ValueError("Session not initialized")
        await self._request(
            "POST",
            "com.atproto.repo.createRecord",
            json={
                "repo": self._session.did,
                "collection": "app.bsky.feed.repost",
                "record": {
                    "$type": "app.bsky.feed.repost",
                    "subject": {"uri": uri, "cid": cid},
                    "createdAt": datetime.now(UTC).isoformat(),
                },
            },
        )

    async def get_notifications(
        self, limit: int = 50, cursor: str | None = None
    ) -> tuple[list[BlueSkyNotification], str | None]:
        params: dict[str, str | int] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor

        response = await self._request(
            "GET", "app.bsky.notification.listNotifications", params=params
        )
        notifications = [
            BlueSkyNotification(
                uri=n["uri"],
                cid=n["cid"],
                author=BlueSkyProfile(
                    did=n["author"]["did"],
                    handle=n["author"]["handle"],
                    display_name=n["author"].get("displayName"),
                ),
                reason=NotificationReason(n["reason"]),
                reason_subject=n.get("reasonSubject"),
                record=n.get("record", {}),
                is_read=n.get("isRead", False),
                indexed_at=n["indexedAt"],
            )
            for n in response.get("notifications", [])
        ]
        return notifications, response.get("cursor")

    async def update_seen_notifications(self) -> None:
        await self._request(
            "POST",
            "app.bsky.notification.updateSeen",
            json={"seenAt": datetime.now(UTC).isoformat()},
        )

    async def get_conversations(
        self, limit: int = 50, cursor: str | None = None
    ) -> tuple[list[BlueSkyConversation], str | None]:
        params: dict[str, str | int] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor

        response = await self._request(
            "GET", "chat.bsky.convo.listConvos", params=params, chat=True
        )
        convos = [
            BlueSkyConversation(
                id=c["id"],
                rev=c["rev"],
                members=c.get("members", []),
                last_message=BlueSkyMessage(
                    id=c["lastMessage"]["id"],
                    rev=c["lastMessage"]["rev"],
                    text=c["lastMessage"].get("text"),
                    sender={"did": c["lastMessage"]["sender"]["did"]},
                    sent_at=c["lastMessage"]["sentAt"],
                )
                if c.get("lastMessage")
                else None,
                unread_count=c.get("unreadCount", 0),
                muted=c.get("muted", False),
            )
            for c in response.get("convos", [])
        ]
        return convos, response.get("cursor")

    async def get_messages(
        self, convo_id: str, limit: int = 50, cursor: str | None = None
    ) -> tuple[list[BlueSkyMessage], str | None]:
        params: dict[str, str | int] = {"convoId": convo_id, "limit": limit}
        if cursor:
            params["cursor"] = cursor

        response = await self._request(
            "GET", "chat.bsky.convo.getMessages", params=params, chat=True
        )
        messages = [
            BlueSkyMessage(
                id=m["id"],
                rev=m["rev"],
                text=m.get("text"),
                sender={"did": m["sender"]["did"]},
                sent_at=m["sentAt"],
            )
            for m in response.get("messages", [])
        ]
        return messages, response.get("cursor")

    async def send_message(self, request: SendMessageRequest) -> BlueSkyMessage:
        if self.config.dry_run:
            logger.info("Dry run: would send message")
            return self._mock_message(request.message.get("text") or "")

        response = await self._request(
            "POST",
            "chat.bsky.convo.sendMessage",
            json={
                "convoId": request.convo_id,
                "message": {"text": request.message.get("text") or ""},
            },
            chat=True,
        )
        return BlueSkyMessage(
            id=response["id"],
            rev=response["rev"],
            text=response.get("text"),
            sender={"did": response["sender"]["did"]},
            sent_at=response["sentAt"],
        )

    async def _request(
        self,
        method: str,
        endpoint: str,
        params: dict[str, str | int] | None = None,
        json: dict[str, str | int | float | bool | dict | list | None] | None = None,
        chat: bool = False,
    ) -> dict[str, str | int | float | bool | dict | list | None]:
        if not self._session:
            raise AuthenticationError("Not authenticated")

        headers = {"Authorization": f"Bearer {self._session.access_jwt}"}
        if chat:
            headers["atproto-proxy"] = BLUESKY_CHAT_SERVICE_DID

        url = f"{self.config.service}/xrpc/{endpoint}"

        try:
            if method == "GET":
                response = await self._http.get(url, params=params, headers=headers)
            else:
                response = await self._http.post(url, json=json, headers=headers)

            if response.status_code == 429:
                raise RateLimitError()
            if not response.is_success:
                raise Exception(f"Request failed: {response.status_code}")
            result: dict[str, str | int | float | bool | dict | list | None] = response.json()
            return result

        except httpx.TimeoutException as e:
            raise NetworkError(f"Timeout: {e}") from e
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

    def _map_post(
        self, data: dict[str, str | int | float | bool | dict | list | None]
    ) -> BlueSkyPost:
        record = data.get("record", {})
        record_dict = record if isinstance(record, dict) else {}
        author_data = data.get("author", {})
        author_dict = author_data if isinstance(author_data, dict) else {}
        return BlueSkyPost(
            uri=str(data.get("uri", "")),
            cid=str(data.get("cid", "")),
            author=BlueSkyProfile(
                did=str(author_dict.get("did", "")),
                handle=str(author_dict.get("handle", "")),
                display_name=str(author_dict.get("displayName", "")) if author_dict.get("displayName") else None,
            ),
            record=PostRecord(
                text=str(record_dict.get("text", "")),
                created_at=str(record_dict.get("createdAt", ""))
            ),
            reply_count=int(data.get("replyCount", 0)) if data.get("replyCount") is not None else None,
            repost_count=int(data.get("repostCount", 0)) if data.get("repostCount") is not None else None,
            like_count=int(data.get("likeCount", 0)) if data.get("likeCount") is not None else None,
            indexed_at=str(data.get("indexedAt", "")),
        )

    def _mock_post(self, text: str) -> BlueSkyPost:
        now = datetime.now(UTC).isoformat()
        return BlueSkyPost(
            uri=f"mock://post/{now}",
            cid=f"mock-cid-{now}",
            author=BlueSkyProfile(
                did=self._session.did if self._session else "did:plc:mock",
                handle=self._session.handle if self._session else "mock.handle",
            ),
            record=PostRecord(text=text, created_at=now),
            indexed_at=now,
        )

    def _mock_message(self, text: str) -> BlueSkyMessage:
        return BlueSkyMessage(
            id=f"mock-msg-{datetime.now(UTC).timestamp()}",
            rev="1",
            text=text,
            sender={"did": self._session.did if self._session else "did:plc:mock"},
            sent_at=datetime.now(UTC).isoformat(),
        )
