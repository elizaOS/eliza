from __future__ import annotations

import base64
import hashlib
import hmac
import time
import urllib.parse
from collections.abc import AsyncIterator

import httpx

from elizaos_plugin_xai.types import (
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
    TwitterConfig,
    Video,
)


class XClientError(Exception):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class TwitterClient:
    API_BASE = "https://api.x.com/2"

    def __init__(self, config: TwitterConfig) -> None:
        self._config = config
        self._client: httpx.AsyncClient | None = None
        self._me: Profile | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._config.timeout),
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> TwitterClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _generate_oauth_signature(
        self,
        method: str,
        url: str,
        params: dict[str, str],
        oauth_params: dict[str, str],
    ) -> str:
        all_params = {**params, **oauth_params}
        sorted_params = sorted(all_params.items())
        param_string = "&".join(
            f"{k}={urllib.parse.quote(str(v), safe='')}" for k, v in sorted_params
        )

        base_string = "&".join(
            [
                method.upper(),
                urllib.parse.quote(url, safe=""),
                urllib.parse.quote(param_string, safe=""),
            ]
        )

        signing_key = "&".join(
            [
                urllib.parse.quote(self._config.api_secret, safe=""),
                urllib.parse.quote(self._config.access_token_secret, safe=""),
            ]
        )

        signature = hmac.new(
            signing_key.encode("utf-8"),
            base_string.encode("utf-8"),
            hashlib.sha1,
        ).digest()

        return base64.b64encode(signature).decode("utf-8")

    def _get_oauth_header(self, method: str, url: str, params: dict[str, str] | None = None) -> str:
        oauth_params = {
            "oauth_consumer_key": self._config.api_key,
            "oauth_nonce": base64.b64encode(str(time.time_ns()).encode()).decode()[:32],
            "oauth_signature_method": "HMAC-SHA1",
            "oauth_timestamp": str(int(time.time())),
            "oauth_token": self._config.access_token,
            "oauth_version": "1.0",
        }

        signature = self._generate_oauth_signature(method, url, params or {}, oauth_params)
        oauth_params["oauth_signature"] = signature

        header_parts = [
            f'{k}="{urllib.parse.quote(v, safe="")}"' for k, v in sorted(oauth_params.items())
        ]
        return f"OAuth {', '.join(header_parts)}"

    def _get_headers(self, method: str = "GET", url: str = "") -> dict[str, str]:
        """Get request headers based on auth mode."""
        if self._config.auth_mode == AuthMode.ENV:
            return {
                "Authorization": self._get_oauth_header(method, url),
                "Content-Type": "application/json",
            }
        if self._config.bearer_token:
            return {
                "Authorization": f"Bearer {self._config.bearer_token}",
                "Content-Type": "application/json",
            }
        raise XClientError("No valid authentication configured")

    async def _request(
        self,
        method: str,
        endpoint: str,
        *,
        json: dict | None = None,
        params: dict | None = None,
    ) -> dict:
        url = f"{self.API_BASE}{endpoint}"
        client = await self._get_client()

        headers = self._get_headers(method, url)
        response = await client.request(method, url, headers=headers, json=json, params=params)

        if not response.is_success:
            error_data = response.json()
            error_text = error_data.get("detail") or error_data.get("title") or response.text
            raise XClientError(
                f"X API error ({response.status_code}): {error_text}",
                status_code=response.status_code,
            )

        return response.json()

    async def me(self) -> Profile:
        if self._me:
            return self._me

        data = await self._request(
            "GET",
            "/users/me",
            params={
                "user.fields": "id,name,username,description,location,url,profile_image_url,verified,protected,created_at,public_metrics",
            },
        )

        user = data["data"]
        metrics = user.get("public_metrics", {})

        self._me = Profile(
            id=user["id"],
            username=user["username"],
            name=user["name"],
            description=user.get("description"),
            location=user.get("location"),
            url=user.get("url"),
            profile_image_url=user.get("profile_image_url"),
            verified=user.get("verified", False),
            protected=user.get("protected", False),
            followers_count=metrics.get("followers_count", 0),
            following_count=metrics.get("following_count", 0),
            post_count=metrics.get("post_count", 0),
            listed_count=metrics.get("listed_count", 0),
        )

        return self._me

    async def get_profile(self, username: str) -> Profile:
        """Get a user's profile by username."""
        data = await self._request(
            "GET",
            f"/users/by/username/{username}",
            params={
                "user.fields": "id,name,username,description,location,url,profile_image_url,verified,protected,created_at,public_metrics",
            },
        )

        user = data["data"]
        metrics = user.get("public_metrics", {})

        return Profile(
            id=user["id"],
            username=user["username"],
            name=user["name"],
            description=user.get("description"),
            location=user.get("location"),
            url=user.get("url"),
            profile_image_url=user.get("profile_image_url"),
            verified=user.get("verified", False),
            protected=user.get("protected", False),
            followers_count=metrics.get("followers_count", 0),
            following_count=metrics.get("following_count", 0),
            post_count=metrics.get("post_count", 0),
            listed_count=metrics.get("listed_count", 0),
        )

    async def get_user_id(self, username: str) -> str:
        profile = await self.get_profile(username)
        return profile.id

    def _parse_post(self, post_data: dict, includes: dict | None = None) -> Post:
        includes = includes or {}
        users = {u["id"]: u for u in includes.get("users", [])}
        media = {m["media_key"]: m for m in includes.get("media", [])}
        polls = {p["id"]: p for p in includes.get("polls", [])}
        places = {p["id"]: p for p in includes.get("places", [])}

        author = users.get(post_data.get("author_id", ""), {})
        metrics = post_data.get("public_metrics", {})
        entities = post_data.get("entities", {})
        refs = post_data.get("referenced_posts", [])
        attachments = post_data.get("attachments", {})

        photos: list[Photo] = []
        videos: list[Video] = []
        for key in attachments.get("media_keys", []):
            m = media.get(key, {})
            if m.get("type") == "photo":
                photos.append(Photo(id=key, url=m.get("url", ""), alt_text=m.get("alt_text")))
            elif m.get("type") in ("video", "animated_gif"):
                url = None
                for v in m.get("variants", []):
                    if v.get("content_type") == "video/mp4":
                        url = v.get("url")
                        break
                videos.append(Video(id=key, preview=m.get("preview_image_url", ""), url=url))

        poll = None
        for poll_id in attachments.get("poll_ids", []):
            p = polls.get(poll_id)
            if p:
                poll = PollData(
                    id=p.get("id"),
                    duration_minutes=p.get("duration_minutes", 0),
                    voting_status=p.get("voting_status"),
                    options=[
                        PollOption(
                            position=o.get("position"),
                            label=o.get("label", ""),
                            votes=o.get("votes"),
                        )
                        for o in p.get("options", [])
                    ],
                )

        place = None
        geo = post_data.get("geo", {})
        if geo.get("place_id"):
            p = places.get(geo["place_id"], {})
            place = PlaceData(
                id=p.get("id"),
                name=p.get("name"),
                full_name=p.get("full_name"),
                country=p.get("country"),
                country_code=p.get("country_code"),
                place_type=p.get("place_type"),
            )

        mentions = [
            Mention(id=m.get("id", ""), username=m.get("username"))
            for m in entities.get("mentions", [])
        ]

        return Post(
            id=post_data["id"],
            text=post_data["text"],
            author_id=post_data.get("author_id"),
            conversation_id=post_data.get("conversation_id"),
            language=post_data.get("lang"),
            username=author.get("username", ""),
            name=author.get("name", ""),
            metrics=PostMetrics(
                like_count=metrics.get("like_count", 0),
                repost_count=metrics.get("repost_count", 0),
                reply_count=metrics.get("reply_count", 0),
                quote_count=metrics.get("quote_count", 0),
                impression_count=metrics.get("impression_count", 0),
                bookmark_count=metrics.get("bookmark_count", 0),
            ),
            hashtags=[h.get("tag", "") for h in entities.get("hashtags", [])],
            mentions=mentions,
            urls=[u.get("url", "") for u in entities.get("urls", [])],
            photos=photos,
            videos=videos,
            poll=poll,
            place=place,
            in_reply_to_id=next((r["id"] for r in refs if r.get("type") == "replied_to"), None),
            quoted_id=next((r["id"] for r in refs if r.get("type") == "quoted"), None),
            reposted_id=next((r["id"] for r in refs if r.get("type") == "reposted"), None),
            is_reply=any(r.get("type") == "replied_to" for r in refs),
            is_repost=any(r.get("type") == "reposted" for r in refs),
            is_quote=any(r.get("type") == "quoted" for r in refs),
            is_sensitive=post_data.get("possibly_sensitive", False),
        )

    async def get_post(self, post_id: str) -> Post:
        data = await self._request(
            "GET",
            f"/posts/{post_id}",
            params={
                "post.fields": "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments,geo,lang,possibly_sensitive",
                "user.fields": "id,name,username,profile_image_url",
                "media.fields": "url,preview_image_url,type,variants,alt_text",
                "poll.fields": "id,options,duration_minutes,end_datetime,voting_status",
                "expansions": "author_id,attachments.media_keys,attachments.poll_ids,referenced_posts.id,geo.place_id",
            },
        )

        return self._parse_post(data["data"], data.get("includes"))

    async def create_post(
        self,
        text: str,
        *,
        reply_to: str | None = None,
        quote_post_id: str | None = None,
        poll: PollData | None = None,
    ) -> PostCreateResult:
        if self._config.dry_run:
            # Return a unique, stable-ish ID so callers can safely dedupe and persist
            # without collisions across multiple dry-run posts.
            return PostCreateResult(id=f"dry-run-{time.time_ns()}", text=text)

        body: dict = {"text": text}

        if reply_to:
            body["reply"] = {"in_reply_to_post_id": reply_to}

        if quote_post_id:
            body["quote_post_id"] = quote_post_id

        if poll:
            body["poll"] = {
                "options": [o.label for o in poll.options],
                "duration_minutes": poll.duration_minutes,
            }

        data = await self._request("POST", "/posts", json=body)
        result = data["data"]

        return PostCreateResult(
            id=result["id"],
            text=result.get("text", text),
        )

    async def delete_post(self, post_id: str) -> bool:
        if self._config.dry_run:
            return True

        data = await self._request("DELETE", f"/posts/{post_id}")
        return data["data"]["deleted"]

    async def like_post(self, post_id: str) -> bool:
        if self._config.dry_run:
            return True

        me = await self.me()
        data = await self._request("POST", f"/users/{me.id}/likes", json={"post_id": post_id})
        return data["data"]["liked"]

    async def unlike_post(self, post_id: str) -> bool:
        if self._config.dry_run:
            return True

        me = await self.me()
        data = await self._request("DELETE", f"/users/{me.id}/likes/{post_id}")
        return not data["data"]["liked"]

    async def repost(self, post_id: str) -> bool:
        if self._config.dry_run:
            return True

        me = await self.me()
        data = await self._request("POST", f"/users/{me.id}/reposts", json={"post_id": post_id})
        return data["data"]["reposted"]

    async def unrepost(self, post_id: str) -> bool:
        if self._config.dry_run:
            return True

        me = await self.me()
        data = await self._request("DELETE", f"/users/{me.id}/reposts/{post_id}")
        return not data["data"]["reposted"]

    async def get_home_timeline(
        self,
        max_results: int = 100,
        pagination_token: str | None = None,
    ) -> QueryPostsResponse:
        params: dict = {
            "max_results": min(max_results, 100),
            "post.fields": "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments",
            "user.fields": "id,name,username,profile_image_url",
            "media.fields": "url,preview_image_url,type",
            "expansions": "author_id,attachments.media_keys,referenced_posts.id",
        }

        if pagination_token:
            params["pagination_token"] = pagination_token

        data = await self._request(
            "GET", "/users/me/timelines/reverse_chronological", params=params
        )

        posts = [self._parse_post(t, data.get("includes")) for t in data.get("data", [])]

        return QueryPostsResponse(
            posts=posts,
            next_token=data.get("meta", {}).get("next_token"),
        )

    async def get_user_posts(
        self,
        user_id: str,
        max_results: int = 100,
        pagination_token: str | None = None,
        *,
        exclude_replies: bool = True,
        exclude_reposts: bool = True,
    ) -> QueryPostsResponse:
        params: dict = {
            "max_results": min(max_results, 100),
            "post.fields": "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments",
            "user.fields": "id,name,username,profile_image_url",
            "media.fields": "url,preview_image_url,type",
            "expansions": "author_id,attachments.media_keys,referenced_posts.id",
        }

        excludes = []
        if exclude_replies:
            excludes.append("replies")
        if exclude_reposts:
            excludes.append("reposts")
        if excludes:
            params["exclude"] = ",".join(excludes)

        if pagination_token:
            params["pagination_token"] = pagination_token

        data = await self._request("GET", f"/users/{user_id}/posts", params=params)

        posts = [self._parse_post(t, data.get("includes")) for t in data.get("data", [])]

        return QueryPostsResponse(
            posts=posts,
            next_token=data.get("meta", {}).get("next_token"),
        )

    async def search_posts(
        self,
        query: str,
        max_results: int = 100,
        *,
        sort_order: str = "relevancy",
    ) -> AsyncIterator[Post]:
        pagination_token: str | None = None
        count = 0

        while count < max_results:
            params: dict = {
                "query": query,
                "max_results": min(max_results - count, 100),
                "sort_order": sort_order,
                "post.fields": "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments",
                "user.fields": "id,name,username,profile_image_url",
                "media.fields": "url,preview_image_url,type",
                "expansions": "author_id,attachments.media_keys,referenced_posts.id",
            }

            if pagination_token:
                params["next_token"] = pagination_token

            data = await self._request("GET", "/posts/search/recent", params=params)

            for post_data in data.get("data", []):
                yield self._parse_post(post_data, data.get("includes"))
                count += 1
                if count >= max_results:
                    break

            pagination_token = data.get("meta", {}).get("next_token")
            if not pagination_token:
                break

    async def get_followers(
        self,
        user_id: str,
        max_results: int = 100,
        pagination_token: str | None = None,
    ) -> QueryProfilesResponse:
        params: dict = {
            "max_results": min(max_results, 1000),
            "user.fields": "id,name,username,description,profile_image_url,verified,public_metrics",
        }

        if pagination_token:
            params["pagination_token"] = pagination_token

        data = await self._request("GET", f"/users/{user_id}/followers", params=params)

        profiles = []
        for u in data.get("data", []):
            metrics = u.get("public_metrics", {})
            profiles.append(
                Profile(
                    id=u["id"],
                    username=u["username"],
                    name=u["name"],
                    description=u.get("description"),
                    profile_image_url=u.get("profile_image_url"),
                    verified=u.get("verified", False),
                    followers_count=metrics.get("followers_count", 0),
                    following_count=metrics.get("following_count", 0),
                    post_count=metrics.get("post_count", 0),
                )
            )

        return QueryProfilesResponse(
            profiles=profiles,
            next_token=data.get("meta", {}).get("next_token"),
        )

    async def get_following(
        self,
        user_id: str,
        max_results: int = 100,
        pagination_token: str | None = None,
    ) -> QueryProfilesResponse:
        params: dict = {
            "max_results": min(max_results, 1000),
            "user.fields": "id,name,username,description,profile_image_url,verified,public_metrics",
        }

        if pagination_token:
            params["pagination_token"] = pagination_token

        data = await self._request("GET", f"/users/{user_id}/following", params=params)

        profiles = []
        for u in data.get("data", []):
            metrics = u.get("public_metrics", {})
            profiles.append(
                Profile(
                    id=u["id"],
                    username=u["username"],
                    name=u["name"],
                    description=u.get("description"),
                    profile_image_url=u.get("profile_image_url"),
                    verified=u.get("verified", False),
                    followers_count=metrics.get("followers_count", 0),
                    following_count=metrics.get("following_count", 0),
                    post_count=metrics.get("post_count", 0),
                )
            )

        return QueryProfilesResponse(
            profiles=profiles,
            next_token=data.get("meta", {}).get("next_token"),
        )

    async def follow_user(self, user_id: str) -> bool:
        """Follow a user."""
        if self._config.dry_run:
            return True

        me = await self.me()
        data = await self._request(
            "POST", f"/users/{me.id}/following", json={"target_user_id": user_id}
        )
        return data["data"]["following"]

    async def unfollow_user(self, user_id: str) -> bool:
        if self._config.dry_run:
            return True

        me = await self.me()
        data = await self._request("DELETE", f"/users/{me.id}/following/{user_id}")
        return not data["data"]["following"]
