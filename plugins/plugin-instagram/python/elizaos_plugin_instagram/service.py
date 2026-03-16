import logging
from collections.abc import Callable

from instagrapi import Client
from instagrapi.exceptions import LoginRequired, TwoFactorRequired

from elizaos_plugin_instagram.config import InstagramConfig
from elizaos_plugin_instagram.error import (
    AuthenticationError,
    MessageSendError,
)
from elizaos_plugin_instagram.types import (
    InstagramEventType,
    InstagramMessage,
    InstagramThread,
    InstagramUser,
)

logger = logging.getLogger(__name__)


class InstagramService:
    def __init__(self, config: InstagramConfig) -> None:
        self.config = config
        self._client: Client | None = None
        self._running = False
        self._message_handlers: list[Callable[[InstagramMessage], None]] = []
        self._event_handlers: dict[InstagramEventType, list[Callable[..., None]]] = {}

    @property
    def client(self) -> Client:
        if self._client is None:
            raise AuthenticationError("Instagram client is not initialized")
        return self._client

    @property
    def is_running(self) -> bool:
        return self._running

    async def start(self) -> None:
        logger.info("Starting Instagram service...")

        self._client = Client()

        if self.config.proxy:
            self._client.set_proxy(self.config.proxy)

        self._client.set_locale(self.config.locale)
        self._client.set_timezone_offset(self.config.timezone_offset)

        try:
            self._client.login(
                self.config.username,
                self.config.password,
            )
        except TwoFactorRequired as exc:
            if not self.config.verification_code:
                raise AuthenticationError(
                    "Two-factor authentication required but no verification code provided"
                ) from exc
            try:
                self._client.login(
                    self.config.username,
                    self.config.password,
                    verification_code=self.config.verification_code,
                )
            except Exception as e:
                raise AuthenticationError("Two-factor authentication failed", e) from e
        except LoginRequired as e:
            raise AuthenticationError("Login failed", e) from e
        except Exception as e:
            raise AuthenticationError(f"Authentication failed: {e}", e) from e

        self._running = True
        logger.info("Instagram service started successfully")

    async def stop(self) -> None:
        if self._client and self._running:
            logger.info("Stopping Instagram service...")
            self._running = False
            self._client = None
            logger.info("Instagram service stopped")

    def on_message(self, handler: Callable[[InstagramMessage], None]) -> None:
        self._message_handlers.append(handler)

    def on_event(self, event_type: InstagramEventType, handler: Callable[..., None]) -> None:
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def send_message(self, thread_id: str, text: str) -> None:
        if self._client is None:
            raise AuthenticationError("Instagram client is not initialized")

        try:
            self._client.direct_send(text, thread_ids=[int(thread_id)])
        except Exception as e:
            raise MessageSendError(thread_id, e) from e

    async def get_threads(self, amount: int = 20) -> list[InstagramThread]:
        if self._client is None:
            raise AuthenticationError("Instagram client is not initialized")

        threads = self._client.direct_threads(amount=amount)

        result: list[InstagramThread] = []
        for thread in threads:
            users = [
                InstagramUser(
                    pk=user.pk,
                    username=user.username,
                    full_name=user.full_name,
                    profile_pic_url=str(user.profile_pic_url) if user.profile_pic_url else None,
                    is_private=user.is_private,
                    is_verified=user.is_verified,
                )
                for user in thread.users
            ]

            result.append(
                InstagramThread(
                    id=str(thread.id),
                    users=users,
                    is_group=thread.is_group,
                    thread_title=thread.thread_title,
                )
            )

        return result

    async def get_user_info(self, username: str) -> InstagramUser:
        if self._client is None:
            raise AuthenticationError("Instagram client is not initialized")

        user = self._client.user_info_by_username(username)

        return InstagramUser(
            pk=user.pk,
            username=user.username,
            full_name=user.full_name,
            profile_pic_url=str(user.profile_pic_url) if user.profile_pic_url else None,
            is_private=user.is_private,
            is_verified=user.is_verified,
            follower_count=user.follower_count,
            following_count=user.following_count,
        )

    def _emit_event(self, event_type: InstagramEventType, payload: object) -> None:
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)
