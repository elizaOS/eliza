import json
import logging
from datetime import datetime
from typing import Any, TypeVar
from urllib.parse import quote

import httpx

from elizaos_plugin_roblox.config import RobloxConfig
from elizaos_plugin_roblox.error import ApiError, NetworkError
from elizaos_plugin_roblox.types import (
    CreatorType,
    DataStoreEntry,
    ExperienceCreator,
    MessagingServiceMessage,
    RobloxExperienceInfo,
    RobloxUser,
)

logger = logging.getLogger(__name__)

ROBLOX_API_BASE = "https://apis.roblox.com"
USERS_API_BASE = "https://users.roblox.com"
GAMES_API_BASE = "https://games.roblox.com"
THUMBNAILS_API_BASE = "https://thumbnails.roblox.com"

T = TypeVar("T")


class RobloxClient:
    def __init__(self, config: RobloxConfig) -> None:
        config.validate()
        self.config = config
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "RobloxClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def _request(
        self,
        method: str,
        base_url: str,
        endpoint: str,
        body: dict[str, Any] | None = None,
        use_api_key: bool = True,
    ) -> dict[str, Any]:
        url = f"{base_url}{endpoint}"
        headers: dict[str, str] = {"Content-Type": "application/json"}

        if use_api_key:
            headers["x-api-key"] = self.config.api_key

        try:
            response = await self._client.request(
                method=method,
                url=url,
                headers=headers,
                json=body,
            )
        except httpx.RequestError as e:
            raise NetworkError(f"Network error: {e}") from e

        if not response.is_success:
            error_body = response.text
            raise ApiError(
                f"API request failed: {error_body}",
                response.status_code,
                endpoint,
                error_body,
            )

        if not response.text:
            return {}

        return response.json()  # type: ignore[no-any-return]

    async def publish_message(
        self,
        topic: str,
        data: object,
        universe_id: str | None = None,
    ) -> None:
        if self.config.dry_run:
            logger.info(f"DRY RUN: Would publish to topic '{topic}': {data}")
            return

        target_universe_id = universe_id or self.config.universe_id
        endpoint = (
            f"/messaging-service/v1/universes/{target_universe_id}/topics/{quote(topic, safe='')}"
        )

        await self._request(
            "POST",
            ROBLOX_API_BASE,
            endpoint,
            body={"message": json.dumps(data)},
        )
        logger.debug(f"Published message to topic: {topic}")

    async def send_agent_message(self, message: MessagingServiceMessage) -> None:
        await self.publish_message(
            self.config.messaging_topic,
            message.model_dump(mode="json"),
        )

    async def get_datastore_entry(
        self,
        datastore_name: str,
        key: str,
        scope: str = "global",
    ) -> DataStoreEntry | None:
        endpoint = (
            f"/datastores/v1/universes/{self.config.universe_id}"
            f"/standard-datastores/datastore/entries/entry"
            f"?datastoreName={quote(datastore_name, safe='')}"
            f"&scope={quote(scope, safe='')}"
            f"&entryKey={quote(key, safe='')}"
        )

        try:
            response = await self._request("GET", ROBLOX_API_BASE, endpoint)
        except ApiError as e:
            if e.status_code == 404:
                return None
            raise

        return DataStoreEntry(
            key=key,
            value=json.loads(response["value"]),
            version=response["version"],
            created_at=datetime.fromisoformat(response["createdTime"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(response["updatedTime"].replace("Z", "+00:00")),
        )

    async def set_datastore_entry(
        self,
        datastore_name: str,
        key: str,
        value: object,
        scope: str = "global",
    ) -> DataStoreEntry:
        if self.config.dry_run:
            logger.info(f"DRY RUN: Would set DataStore entry '{key}': {value}")
            now = datetime.now()
            return DataStoreEntry(
                key=key,
                value=value,
                version="dry-run",
                created_at=now,
                updated_at=now,
            )

        endpoint = (
            f"/datastores/v1/universes/{self.config.universe_id}"
            f"/standard-datastores/datastore/entries/entry"
            f"?datastoreName={quote(datastore_name, safe='')}"
            f"&scope={quote(scope, safe='')}"
            f"&entryKey={quote(key, safe='')}"
        )

        response = await self._request("POST", ROBLOX_API_BASE, endpoint, body=value)

        return DataStoreEntry(
            key=key,
            value=value,
            version=response["version"],
            created_at=datetime.fromisoformat(response["createdTime"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(response["updatedTime"].replace("Z", "+00:00")),
        )

    async def delete_datastore_entry(
        self,
        datastore_name: str,
        key: str,
        scope: str = "global",
    ) -> None:
        if self.config.dry_run:
            logger.info(f"DRY RUN: Would delete DataStore entry '{key}'")
            return

        endpoint = (
            f"/datastores/v1/universes/{self.config.universe_id}"
            f"/standard-datastores/datastore/entries/entry"
            f"?datastoreName={quote(datastore_name, safe='')}"
            f"&scope={quote(scope, safe='')}"
            f"&entryKey={quote(key, safe='')}"
        )

        await self._request("DELETE", ROBLOX_API_BASE, endpoint)

    async def get_user_by_id(self, user_id: int) -> RobloxUser:
        endpoint = f"/v1/users/{user_id}"
        response = await self._request("GET", USERS_API_BASE, endpoint, use_api_key=False)

        return RobloxUser(
            id=response["id"],
            username=response["name"],
            display_name=response["displayName"],
            created_at=datetime.fromisoformat(response["created"].replace("Z", "+00:00")),
            is_banned=response.get("isBanned", False),
        )

    async def get_user_by_username(self, username: str) -> RobloxUser | None:
        endpoint = "/v1/usernames/users"
        response = await self._request(
            "POST",
            USERS_API_BASE,
            endpoint,
            body={"usernames": [username], "excludeBannedUsers": False},
            use_api_key=False,
        )

        data = response.get("data", [])
        if not data:
            return None

        user = data[0]
        return RobloxUser(
            id=user["id"],
            username=user["name"],
            display_name=user["displayName"],
        )

    async def get_avatar_url(self, user_id: int, size: str = "150x150") -> str | None:
        endpoint = f"/v1/users/avatar-headshot?userIds={user_id}&size={size}&format=Png"

        try:
            response = await self._request("GET", THUMBNAILS_API_BASE, endpoint, use_api_key=False)
            data = response.get("data", [])
            if data:
                return data[0].get("imageUrl")
        except Exception:  # noqa: S110
            # Avatar URL is optional, silently return None on any error
            pass

        return None

    async def get_experience_info(self, universe_id: str | None = None) -> RobloxExperienceInfo:
        target_universe_id = universe_id or self.config.universe_id
        endpoint = f"/v1/games?universeIds={target_universe_id}"

        response = await self._request("GET", GAMES_API_BASE, endpoint, use_api_key=False)

        data = response.get("data", [])
        if not data:
            raise ApiError(
                f"Experience not found: {target_universe_id}",
                404,
                endpoint,
            )

        game = data[0]
        creator = game["creator"]

        return RobloxExperienceInfo(
            universe_id=target_universe_id,
            name=game["name"],
            description=game.get("description"),
            creator=ExperienceCreator(
                id=creator["id"],
                creator_type=CreatorType.USER if creator["type"] == "User" else CreatorType.GROUP,
                name=creator["name"],
            ),
            playing=game.get("playing"),
            visits=game.get("visits"),
            root_place_id=str(game["rootPlaceId"]),
        )

    def is_dry_run(self) -> bool:
        return self.config.dry_run
