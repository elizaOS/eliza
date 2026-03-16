"""Zalo API client implementation."""

import logging
from typing import Any

import httpx

from elizaos_plugin_zalo.error import ApiError, MessageSendError, TokenRefreshError, UserNotFoundError
from elizaos_plugin_zalo.types import ZaloApiResponse, ZaloOAInfo, ZaloSendImageParams, ZaloSendMessageParams

logger = logging.getLogger(__name__)

# API endpoints
ZALO_OA_API_BASE = "https://openapi.zalo.me/v2.0/oa"
ZALO_OAUTH_API_BASE = "https://oauth.zaloapp.com/v4"

# Message limits
MAX_MESSAGE_LENGTH = 2000


class ZaloClient:
    """Zalo Official Account API client."""

    def __init__(self, access_token: str, proxy_url: str | None = None) -> None:
        """Initialize the Zalo client.
        
        Args:
            access_token: OAuth access token.
            proxy_url: Optional HTTP proxy URL.
        """
        self._access_token = access_token
        self._proxy_url = proxy_url
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the HTTP client."""
        if self._client is None:
            kwargs: dict[str, Any] = {}
            if self._proxy_url:
                kwargs["proxy"] = self._proxy_url
            self._client = httpx.AsyncClient(**kwargs)
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def set_access_token(self, token: str) -> None:
        """Update the access token."""
        self._access_token = token

    def _get_headers(self) -> dict[str, str]:
        """Get headers for API requests."""
        return {
            "access_token": self._access_token,
            "Content-Type": "application/json",
        }

    async def get_oa_info(self) -> ZaloOAInfo:
        """Get Official Account information."""
        client = await self._get_client()
        url = f"{ZALO_OA_API_BASE}/getoa"

        response = await client.get(url, headers=self._get_headers())
        data = response.json()

        if data.get("error", 0) != 0:
            raise ApiError(data.get("message", "Unknown error"), data.get("error"))

        oa_data = data.get("data", {})
        return ZaloOAInfo(
            oa_id=oa_data.get("oa_id", ""),
            name=oa_data.get("name", ""),
            description=oa_data.get("description"),
            avatar=oa_data.get("avatar"),
            cover=oa_data.get("cover"),
        )

    async def send_message(self, params: ZaloSendMessageParams) -> str:
        """Send a text message.
        
        Args:
            params: Message parameters.
            
        Returns:
            Message ID.
            
        Raises:
            MessageSendError: If the message fails to send.
        """
        client = await self._get_client()
        url = f"{ZALO_OA_API_BASE}/message"

        body = {
            "recipient": {"user_id": params.user_id},
            "message": {"text": params.text[:MAX_MESSAGE_LENGTH]},
        }

        try:
            response = await client.post(url, headers=self._get_headers(), json=body)
            data = response.json()

            if data.get("error", 0) != 0:
                raise ApiError(data.get("message", "Unknown error"), data.get("error"))

            return data.get("data", {}).get("message_id", "")
        except httpx.HTTPError as e:
            raise MessageSendError(params.user_id, e) from e

    async def send_image(self, params: ZaloSendImageParams) -> str:
        """Send an image message.
        
        Args:
            params: Image message parameters.
            
        Returns:
            Message ID.
            
        Raises:
            MessageSendError: If the message fails to send.
        """
        client = await self._get_client()
        url = f"{ZALO_OA_API_BASE}/message"

        message: dict[str, Any] = {
            "attachment": {
                "type": "template",
                "payload": {
                    "template_type": "media",
                    "elements": [
                        {
                            "media_type": "image",
                            "url": params.image_url,
                        }
                    ],
                },
            },
        }

        if params.caption:
            message["text"] = params.caption

        body = {
            "recipient": {"user_id": params.user_id},
            "message": message,
        }

        try:
            response = await client.post(url, headers=self._get_headers(), json=body)
            data = response.json()

            if data.get("error", 0) != 0:
                raise ApiError(data.get("message", "Unknown error"), data.get("error"))

            return data.get("data", {}).get("message_id", "")
        except httpx.HTTPError as e:
            raise MessageSendError(params.user_id, e) from e

    async def get_user_profile(self, user_id: str) -> dict[str, Any]:
        """Get user profile.
        
        Args:
            user_id: User ID.
            
        Returns:
            User profile data.
            
        Raises:
            UserNotFoundError: If the user is not found.
        """
        client = await self._get_client()
        import json
        data_param = json.dumps({"user_id": user_id})
        url = f"{ZALO_OA_API_BASE}/getprofile?data={data_param}"

        response = await client.get(url, headers=self._get_headers())
        data = response.json()

        if data.get("error", 0) != 0:
            raise UserNotFoundError(user_id)

        return data.get("data", {})

    @staticmethod
    async def refresh_token(
        app_id: str,
        secret_key: str,
        refresh_token: str,
    ) -> dict[str, Any]:
        """Refresh the access token.
        
        Args:
            app_id: Application ID.
            secret_key: Secret key.
            refresh_token: Refresh token.
            
        Returns:
            Dictionary with access_token, refresh_token, and expires_in.
            
        Raises:
            TokenRefreshError: If token refresh fails.
        """
        url = f"{ZALO_OAUTH_API_BASE}/oa/access_token"

        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                headers={
                    "secret_key": secret_key,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "app_id": app_id,
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                },
            )

            data = response.json()

            if data.get("error"):
                raise TokenRefreshError(
                    data.get("error_description", f"Error code: {data.get('error')}")
                )

            return {
                "access_token": data.get("access_token"),
                "refresh_token": data.get("refresh_token"),
                "expires_in": data.get("expires_in", 3600),
            }
