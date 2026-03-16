"""
Nostr service implementation for elizaOS.
"""

import asyncio
import json
import logging
import os
import time

import secp256k1
import websockets

from .types import (
    DEFAULT_NOSTR_RELAYS,
    NOSTR_SERVICE_NAME,
    NostrConfigurationError,
    NostrCryptoError,
    NostrDmSendOptions,
    NostrEventTypes,
    NostrProfile,
    NostrSendResult,
    NostrSettings,
    normalize_pubkey,
    pubkey_to_npub,
    validate_private_key,
)

logger = logging.getLogger(__name__)


class NostrService:
    """Nostr messaging service for elizaOS agents."""

    service_type = NOSTR_SERVICE_NAME

    def __init__(self):
        self.runtime = None
        self.settings: NostrSettings | None = None
        self._private_key: bytes | None = None
        self._private_key_obj: secp256k1.PrivateKey | None = None
        self._connected = False
        self._seen_event_ids: set[str] = set()
        self._ws_connections: dict[str, websockets.WebSocketClientProtocol] = {}
        self._subscription_tasks: list[asyncio.Task] = []

    async def start(self, runtime) -> None:
        """Start the Nostr service."""
        logger.info("Starting Nostr service...")

        self.runtime = runtime
        self.settings = self._load_settings()
        self._validate_settings()

        # Initialize private key
        self._private_key = validate_private_key(self.settings.private_key)
        self._private_key_obj = secp256k1.PrivateKey(self._private_key)

        # Connect to relays
        await self._connect_relays()

        # Start subscription
        await self._start_subscription()

        self._connected = True
        logger.info(f"Nostr service started (pubkey: {self.settings.public_key[:16]}...)")

        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(NostrEventTypes.CONNECTION_READY, {"service": self})

    async def stop(self) -> None:
        """Stop the Nostr service."""
        logger.info("Stopping Nostr service...")
        self._connected = False

        # Cancel subscription tasks
        for task in self._subscription_tasks:
            task.cancel()
        self._subscription_tasks.clear()

        # Close WebSocket connections
        for ws in self._ws_connections.values():
            await ws.close()
        self._ws_connections.clear()

        self.runtime = None
        self._private_key = None
        self._private_key_obj = None
        self._seen_event_ids.clear()
        logger.info("Nostr service stopped")

    def _load_settings(self) -> NostrSettings:
        """Load settings from runtime configuration."""
        if not self.runtime:
            raise NostrConfigurationError("Runtime not initialized")

        get_setting = getattr(self.runtime, "get_setting", lambda x: None)

        private_key = (
            get_setting("NOSTR_PRIVATE_KEY")
            or os.environ.get("NOSTR_PRIVATE_KEY")
            or ""
        )

        relays_raw = (
            get_setting("NOSTR_RELAYS")
            or os.environ.get("NOSTR_RELAYS")
            or ""
        )

        dm_policy = (
            get_setting("NOSTR_DM_POLICY")
            or os.environ.get("NOSTR_DM_POLICY")
            or "pairing"
        )

        allow_from_raw = (
            get_setting("NOSTR_ALLOW_FROM")
            or os.environ.get("NOSTR_ALLOW_FROM")
            or ""
        )

        enabled = (
            get_setting("NOSTR_ENABLED")
            or os.environ.get("NOSTR_ENABLED")
            or "true"
        )

        # Parse relays
        relays = (
            [r.strip() for r in relays_raw.split(",") if r.strip()]
            if relays_raw
            else DEFAULT_NOSTR_RELAYS.copy()
        )

        # Parse allow list
        allow_from = []
        if allow_from_raw:
            for p in allow_from_raw.split(","):
                try:
                    allow_from.append(normalize_pubkey(p.strip()))
                except NostrCryptoError:
                    allow_from.append(p.strip())

        # Derive public key
        public_key = ""
        if private_key:
            try:
                sk_bytes = validate_private_key(private_key)
                pk_obj = secp256k1.PrivateKey(sk_bytes)
                public_key = pk_obj.pubkey.serialize(compressed=False)[1:33].hex()
            except Exception:
                pass

        return NostrSettings(
            private_key=private_key,
            public_key=public_key,
            relays=relays,
            dm_policy=dm_policy,
            allow_from=allow_from,
            enabled=enabled.lower() != "false",
        )

    def _validate_settings(self) -> None:
        """Validate the settings."""
        settings = self.settings
        if not settings:
            raise NostrConfigurationError("Settings not loaded")

        if not settings.private_key:
            raise NostrConfigurationError(
                "NOSTR_PRIVATE_KEY is required", "NOSTR_PRIVATE_KEY"
            )

        if not settings.public_key:
            raise NostrConfigurationError(
                "Invalid private key - could not derive public key",
                "NOSTR_PRIVATE_KEY",
            )

        if not settings.relays:
            raise NostrConfigurationError(
                "At least one relay is required", "NOSTR_RELAYS"
            )

        for relay in settings.relays:
            if not relay.startswith("wss://") and not relay.startswith("ws://"):
                raise NostrConfigurationError(
                    f"Invalid relay URL: {relay}", "NOSTR_RELAYS"
                )

    async def _connect_relays(self) -> None:
        """Connect to all relays."""
        settings = self.settings
        if not settings:
            return

        for relay in settings.relays:
            try:
                ws = await websockets.connect(relay)
                self._ws_connections[relay] = ws
                logger.debug(f"Connected to relay: {relay}")
            except Exception as e:
                logger.warning(f"Failed to connect to {relay}: {e}")

    async def _start_subscription(self) -> None:
        """Start the DM subscription."""
        settings = self.settings
        if not settings:
            return

        since = int(time.time()) - 120  # Last 2 minutes

        # Create subscription filter
        sub_filter = {
            "kinds": [4],
            "#p": [settings.public_key],
            "since": since,
        }

        # Subscribe to each relay
        for relay, ws in self._ws_connections.items():
            sub_id = f"dm-{int(time.time())}"
            sub_msg = json.dumps(["REQ", sub_id, sub_filter])

            try:
                await ws.send(sub_msg)
                task = asyncio.create_task(self._listen_relay(relay, ws))
                self._subscription_tasks.append(task)
            except Exception as e:
                logger.warning(f"Failed to subscribe to {relay}: {e}")

    async def _listen_relay(self, relay: str, ws: websockets.WebSocketClientProtocol) -> None:
        """Listen for messages from a relay."""
        try:
            async for message in ws:
                try:
                    data = json.loads(message)
                    if data[0] == "EVENT":
                        await self._handle_event(data[2])
                except (json.JSONDecodeError, IndexError):
                    pass
        except websockets.ConnectionClosed:
            logger.debug(f"Connection closed: {relay}")
        except Exception as e:
            logger.warning(f"Relay error ({relay}): {e}")

    async def _handle_event(self, event: dict) -> None:
        """Handle an incoming event."""
        settings = self.settings
        if not settings or not self._private_key:
            return

        event_id = event.get("id", "")

        # Dedupe
        if event_id in self._seen_event_ids:
            return
        self._seen_event_ids.add(event_id)

        # Limit seen set size
        if len(self._seen_event_ids) > 10000:
            to_remove = list(self._seen_event_ids)[:5000]
            for eid in to_remove:
                self._seen_event_ids.discard(eid)

        sender_pubkey = event.get("pubkey", "")

        # Skip self-messages
        if sender_pubkey == settings.public_key:
            return

        # Check if addressed to us
        tags = event.get("tags", [])
        is_to_us = any(t[0] == "p" and t[1] == settings.public_key for t in tags if len(t) > 1)
        if not is_to_us:
            return

        # Check DM policy
        if settings.dm_policy == "disabled":
            logger.debug(f"DM from {sender_pubkey} blocked - DMs disabled")
            return

        if settings.dm_policy == "allowlist":
            if sender_pubkey not in settings.allow_from:
                logger.debug(f"DM from {sender_pubkey} blocked - not in allowlist")
                return

        # Decrypt the message
        content = event.get("content", "")
        try:
            plaintext = self._decrypt_nip04(sender_pubkey, content)
        except Exception as e:
            logger.warning(f"Failed to decrypt DM from {sender_pubkey}: {e}")
            return

        logger.debug(f"Received DM from {sender_pubkey[:8]}...: {plaintext[:50]}...")

        # Emit event
        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(
                NostrEventTypes.MESSAGE_RECEIVED,
                {
                    "from": sender_pubkey,
                    "text": plaintext,
                    "event_id": event_id,
                    "created_at": event.get("created_at"),
                },
            )

    def _decrypt_nip04(self, sender_pubkey: str, ciphertext: str) -> str:
        """Decrypt a NIP-04 encrypted message."""
        # This is a simplified implementation - in production use a proper NIP-04 library
        # For now, we'll raise an error indicating this needs a proper implementation
        raise NotImplementedError(
            "NIP-04 decryption requires a proper cryptographic implementation. "
            "Consider using a library like 'python-nostr' or implementing the full NIP-04 spec."
        )

    def _encrypt_nip04(self, recipient_pubkey: str, plaintext: str) -> str:
        """Encrypt a NIP-04 message."""
        # This is a simplified implementation - in production use a proper NIP-04 library
        raise NotImplementedError(
            "NIP-04 encryption requires a proper cryptographic implementation."
        )

    def is_connected(self) -> bool:
        """Check if the service is connected."""
        return self._connected

    def get_public_key(self) -> str:
        """Get the bot's public key in hex format."""
        return self.settings.public_key if self.settings else ""

    def get_npub(self) -> str:
        """Get the bot's public key in npub format."""
        pk = self.get_public_key()
        return pubkey_to_npub(pk) if pk else ""

    def get_relays(self) -> list[str]:
        """Get connected relays."""
        return self.settings.relays if self.settings else []

    async def send_dm(self, options: NostrDmSendOptions) -> NostrSendResult:
        """Send a DM to a pubkey."""
        settings = self.settings
        if not settings or not self._private_key:
            return NostrSendResult(success=False, error="Service not initialized")

        # Normalize target pubkey
        try:
            normalize_pubkey(options.to_pubkey)
        except NostrCryptoError as e:
            return NostrSendResult(success=False, error=f"Invalid target pubkey: {e}")

        # Note: Full NIP-04 encryption implementation needed here
        # This is a placeholder that indicates the need for proper crypto
        return NostrSendResult(
            success=False,
            error="NIP-04 encryption not fully implemented - use TypeScript version",
        )

    async def publish_profile(self, profile: NostrProfile) -> NostrSendResult:
        """Publish profile (kind:0)."""
        settings = self.settings
        if not settings or not self._private_key:
            return NostrSendResult(success=False, error="Service not initialized")

        # Note: Event signing implementation needed here
        return NostrSendResult(
            success=False,
            error="Event signing not fully implemented - use TypeScript version",
        )

    def get_settings(self) -> NostrSettings | None:
        """Get the settings."""
        return self.settings
