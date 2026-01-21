import asyncio
import logging
import random
import time
from datetime import datetime

from elizaos_browser.services.process_manager import BrowserProcessManager
from elizaos_browser.services.websocket_client import BrowserWebSocketClient
from elizaos_browser.types import BrowserConfig, BrowserSession

logger = logging.getLogger(__name__)


class BrowserService:
    def __init__(self, config: BrowserConfig | None = None) -> None:
        self.config = config or BrowserConfig()
        self._sessions: dict[str, BrowserSession] = {}
        self._current_session_id: str | None = None
        self._client = BrowserWebSocketClient(f"ws://localhost:{self.config.server_port}")
        self._process_manager = BrowserProcessManager(self.config.server_port)
        self._initialized = False
        self._owns_server = False  # True if we started the server

    async def start(self) -> None:
        logger.info("Starting browser automation service")
        try:
            # Try to connect first (server might already be running)
            logger.info("Checking for existing browser server...")
            existing_server_works = False

            try:
                await self._client.connect()
                # Give it a moment then check if still connected
                await asyncio.sleep(0.5)
                if self._client.is_connected():
                    # Try a quick health check
                    try:
                        is_healthy = await asyncio.wait_for(self._client.health(), timeout=5.0)
                        if is_healthy:
                            logger.info("Connected to existing healthy browser server")
                            existing_server_works = True
                    except Exception as e:
                        logger.debug(f"Existing server health check failed: {e}")
            except Exception as e:
                logger.debug(f"Could not connect to existing server: {e}")

            if not existing_server_works:
                # Disconnect from any stale server
                self._client.disconnect()
                await asyncio.sleep(0.5)

                # Recreate client with fresh connection
                self._client = BrowserWebSocketClient(f"ws://localhost:{self.config.server_port}")

                # Start our own server
                logger.info("Starting new browser server...")
                await self._process_manager.start()
                self._owns_server = True

                # Connect to our server
                await self._client.connect()
                await self._wait_for_ready()

            self._initialized = True
            logger.info("Browser service initialized successfully")
        except Exception as e:
            logger.error(f"Failed to start browser service: {e}")
            if self._owns_server:
                self._process_manager.stop()
            raise

    async def stop(self) -> None:
        logger.info("Stopping browser automation service")

        for session_id in list(self._sessions.keys()):
            await self.destroy_session(session_id)

        self._client.disconnect()

        # Stop server if we started it
        if self._owns_server:
            self._process_manager.stop()
            self._owns_server = False

        self._initialized = False

    async def create_session(self, session_id: str) -> BrowserSession:
        if not self._initialized:
            raise RuntimeError("Browser service not initialized")

        response = await self._client.send_message("createSession", {})
        server_session_id = (response.data or {}).get("sessionId")
        if not server_session_id:
            raise RuntimeError("Failed to create session on server")

        session = BrowserSession(id=server_session_id, created_at=datetime.now())
        self._sessions[session_id] = session
        self._current_session_id = session_id

        return session

    async def get_session(self, session_id: str) -> BrowserSession | None:
        return self._sessions.get(session_id)

    async def get_current_session(self) -> BrowserSession | None:
        if not self._current_session_id:
            return None
        return self._sessions.get(self._current_session_id)

    async def get_or_create_session(self) -> BrowserSession:
        current = await self.get_current_session()
        if current:
            return current

        session_id = f"session-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
        return await self.create_session(session_id)

    async def destroy_session(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session:
            await self._client.send_message(
                "destroySession",
                {"sessionId": session.id},
            )
            del self._sessions[session_id]
            if self._current_session_id == session_id:
                self._current_session_id = None

    def get_client(self) -> BrowserWebSocketClient:
        if not self._initialized:
            raise RuntimeError("Browser service not initialized")
        return self._client

    async def _wait_for_ready(
        self,
        max_attempts: int = 60,
        delay_seconds: float = 3.0,
    ) -> None:
        logger.info("Waiting for browser server to be ready...")

        for attempt in range(1, max_attempts + 1):
            try:
                is_healthy = await self._client.health()
                if is_healthy:
                    logger.info("Browser server is ready")
                    return
            except Exception as e:
                logger.debug(f"Health check attempt {attempt}/{max_attempts} failed: {e}")

            if attempt < max_attempts:
                logger.info(
                    f"Server not ready yet, retrying in {delay_seconds}s... "
                    f"(attempt {attempt}/{max_attempts})"
                )
                await asyncio.sleep(delay_seconds)

        raise RuntimeError(f"Browser server did not become ready after {max_attempts} attempts")
