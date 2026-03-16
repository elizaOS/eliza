"""
iMessage service implementation for elizaOS.
"""

import asyncio
import logging
import os
import subprocess

from .types import (
    DEFAULT_POLL_INTERVAL_MS,
    IMESSAGE_SERVICE_NAME,
    IMessageChat,
    IMessageCliError,
    IMessageConfigurationError,
    IMessageEventTypes,
    IMessageMessage,
    IMessageNotSupportedError,
    IMessageSendResult,
    IMessageSettings,
    format_phone_number,
    is_macos,
    is_phone_number,
    split_message_for_imessage,
)

logger = logging.getLogger(__name__)


class IMessageService:
    """iMessage service for elizaOS agents (macOS only)."""

    service_type = IMESSAGE_SERVICE_NAME

    def __init__(self):
        self.runtime = None
        self.settings: IMessageSettings | None = None
        self._connected = False
        self._poll_task: asyncio.Task | None = None
        self._last_message_id: str | None = None

    async def start(self, runtime) -> None:
        """Start the iMessage service."""
        logger.info("Starting iMessage service...")
        self.runtime = runtime

        # Check if running on macOS
        if not is_macos():
            raise IMessageNotSupportedError()

        # Load settings
        self.settings = self._load_settings()
        await self._validate_settings()

        # Start polling for new messages
        if self.settings.poll_interval_ms > 0:
            self._start_polling()

        self._connected = True
        logger.info("iMessage service started")

        # Emit connection ready event
        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(IMessageEventTypes.CONNECTION_READY, {"service": self})

    async def stop(self) -> None:
        """Stop the iMessage service."""
        logger.info("Stopping iMessage service...")
        self._connected = False

        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

        self.settings = None
        self.runtime = None
        self._last_message_id = None
        logger.info("iMessage service stopped")

    def is_connected(self) -> bool:
        """Check if the service is connected."""
        return self._connected

    def is_macos(self) -> bool:
        """Check if running on macOS."""
        return is_macos()

    async def send_message(
        self,
        to: str,
        text: str,
        media_url: str | None = None,
        max_bytes: int | None = None,
    ) -> IMessageSendResult:
        """Send a message via iMessage."""
        if not self.settings:
            return IMessageSendResult(success=False, error="Service not initialized")

        # Format phone number if needed
        target = format_phone_number(to) if is_phone_number(to) else to

        # Split message if too long
        chunks = split_message_for_imessage(text)

        for chunk in chunks:
            result = await self._send_single_message(target, chunk, media_url)
            if not result.success:
                return result

        # Emit sent event
        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(
                IMessageEventTypes.MESSAGE_SENT,
                {"to": target, "text": text, "has_media": bool(media_url)},
            )

        return IMessageSendResult(
            success=True,
            message_id=str(int(__import__("time").time() * 1000)),
            chat_id=target,
        )

    async def get_recent_messages(self, limit: int = 50) -> list[IMessageMessage]:
        """Get recent messages."""
        if not self.settings:
            return []

        script = f'''
            tell application "Messages"
                set recentMessages to {{}}
                repeat with i from 1 to {limit}
                    try
                        set msg to item i of (get messages)
                        set msgText to text of msg
                        set msgSender to handle of sender of msg
                        set msgDate to date of msg
                        set end of recentMessages to {{msgText, msgSender, msgDate}}
                    end try
                end repeat
                return recentMessages
            end tell
        '''

        try:
            result = await self._run_applescript(script)
            return self._parse_messages_result(result)
        except Exception as e:
            logger.warning(f"Failed to get recent messages: {e}")
            return []

    async def get_chats(self) -> list[IMessageChat]:
        """Get chats."""
        if not self.settings:
            return []

        script = '''
            tell application "Messages"
                set chatList to {}
                repeat with c in chats
                    set chatId to id of c
                    set chatName to name of c
                    set end of chatList to {chatId, chatName}
                end repeat
                return chatList
            end tell
        '''

        try:
            result = await self._run_applescript(script)
            return self._parse_chats_result(result)
        except Exception as e:
            logger.warning(f"Failed to get chats: {e}")
            return []

    def get_settings(self) -> IMessageSettings | None:
        """Get current settings."""
        return self.settings

    # Private methods

    def _load_settings(self) -> IMessageSettings:
        """Load settings from runtime and environment."""
        if not self.runtime:
            raise IMessageConfigurationError("Runtime not initialized")

        get_setting = getattr(self.runtime, "get_setting", lambda x: None)

        cli_path = (
            get_setting("IMESSAGE_CLI_PATH")
            or os.environ.get("IMESSAGE_CLI_PATH", "imsg")
        )

        db_path = (
            get_setting("IMESSAGE_DB_PATH")
            or os.environ.get("IMESSAGE_DB_PATH")
        )

        poll_interval_ms = int(
            get_setting("IMESSAGE_POLL_INTERVAL_MS")
            or os.environ.get("IMESSAGE_POLL_INTERVAL_MS", str(DEFAULT_POLL_INTERVAL_MS))
        )

        dm_policy = (
            get_setting("IMESSAGE_DM_POLICY")
            or os.environ.get("IMESSAGE_DM_POLICY", "pairing")
        )

        group_policy = (
            get_setting("IMESSAGE_GROUP_POLICY")
            or os.environ.get("IMESSAGE_GROUP_POLICY", "allowlist")
        )

        allow_from_raw = (
            get_setting("IMESSAGE_ALLOW_FROM")
            or os.environ.get("IMESSAGE_ALLOW_FROM", "")
        )
        allow_from = [s.strip() for s in allow_from_raw.split(",") if s.strip()]

        enabled_raw = (
            get_setting("IMESSAGE_ENABLED")
            or os.environ.get("IMESSAGE_ENABLED", "true")
        )
        enabled = enabled_raw.lower() != "false"

        return IMessageSettings(
            cli_path=cli_path,
            db_path=db_path,
            poll_interval_ms=poll_interval_ms,
            dm_policy=dm_policy,
            group_policy=group_policy,
            allow_from=allow_from,
            enabled=enabled,
        )

    async def _validate_settings(self) -> None:
        """Validate settings."""
        if not self.settings:
            raise IMessageConfigurationError("Settings not loaded")

        # Check if CLI tool exists (if specified and not default)
        if self.settings.cli_path != "imsg":
            if not os.path.exists(self.settings.cli_path):
                logger.warning(
                    f"iMessage CLI not found at {self.settings.cli_path}, will use AppleScript"
                )

        # Check if Messages app is accessible
        try:
            await self._run_applescript('tell application "Messages" to return 1')
        except Exception as e:
            raise IMessageConfigurationError(
                "Cannot access Messages app. Ensure Full Disk Access is granted."
            ) from e

    async def _send_single_message(
        self,
        to: str,
        text: str,
        media_url: str | None = None,
    ) -> IMessageSendResult:
        """Send a single message."""
        # Try CLI first if available
        if self.settings and self.settings.cli_path != "imsg":
            try:
                return await self._send_via_cli(to, text, media_url)
            except Exception as e:
                logger.debug(f"CLI send failed, falling back to AppleScript: {e}")

        # Fall back to AppleScript
        return await self._send_via_applescript(to, text, media_url)

    async def _send_via_cli(
        self,
        to: str,
        text: str,
        media_url: str | None = None,
    ) -> IMessageSendResult:
        """Send via CLI tool."""
        if not self.settings:
            return IMessageSendResult(success=False, error="Service not initialized")

        cmd = [self.settings.cli_path, to, text]
        if media_url:
            cmd.extend(["--attachment", media_url])

        try:
            subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
            )
            return IMessageSendResult(
                success=True,
                message_id=str(int(__import__("time").time() * 1000)),
                chat_id=to,
            )
        except subprocess.CalledProcessError as e:
            raise IMessageCliError(e.stderr or "CLI command failed", e.returncode) from e

    async def _send_via_applescript(
        self,
        to: str,
        text: str,
        media_url: str | None = None,
    ) -> IMessageSendResult:
        """Send via AppleScript."""
        # Escape text for AppleScript
        escaped_text = text.replace("\\", "\\\\").replace('"', '\\"')

        if to.startswith("chat_id:"):
            # Send to existing chat
            chat_id = to[8:]
            script = f'''
                tell application "Messages"
                    set targetChat to chat id "{chat_id}"
                    send "{escaped_text}" to targetChat
                end tell
            '''
        else:
            # Send to buddy (phone/email)
            script = f'''
                tell application "Messages"
                    set targetService to 1st account whose service type = iMessage
                    set targetBuddy to participant "{to}" of targetService
                    send "{escaped_text}" to targetBuddy
                end tell
            '''

        try:
            await self._run_applescript(script)
            return IMessageSendResult(
                success=True,
                message_id=str(int(__import__("time").time() * 1000)),
                chat_id=to,
            )
        except Exception as e:
            return IMessageSendResult(success=False, error=f"AppleScript error: {e}")

    async def _run_applescript(self, script: str) -> str:
        """Run an AppleScript."""
        # Escape single quotes for shell
        escaped_script = script.replace("'", "'\"'\"'")

        process = await asyncio.create_subprocess_shell(
            f"osascript -e '{escaped_script}'",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            raise Exception(stderr.decode() or "AppleScript execution failed")

        return stdout.decode().strip()

    def _start_polling(self) -> None:
        """Start polling for new messages."""
        if not self.settings:
            return

        async def poll_loop():
            while self._connected and self.settings:
                try:
                    await self._poll_for_new_messages()
                except Exception as e:
                    logger.debug(f"Polling error: {e}")
                await asyncio.sleep(self.settings.poll_interval_ms / 1000)

        self._poll_task = asyncio.create_task(poll_loop())

    async def _poll_for_new_messages(self) -> None:
        """Poll for new messages."""
        if not self.runtime:
            return

        messages = await self.get_recent_messages(10)

        for msg in messages:
            # Skip if we've already seen this message
            if self._last_message_id and msg.id <= self._last_message_id:
                continue

            # Skip messages from self
            if msg.is_from_me:
                continue

            # Check DM policy
            if not self._is_allowed(msg.handle):
                continue

            # Emit message received event
            if hasattr(self.runtime, "emit"):
                self.runtime.emit(IMessageEventTypes.MESSAGE_RECEIVED, {"message": msg})

            self._last_message_id = msg.id

    def _is_allowed(self, handle: str) -> bool:
        """Check if a handle is allowed."""
        if not self.settings:
            return False

        if self.settings.dm_policy == "open":
            return True

        if self.settings.dm_policy == "disabled":
            return False

        if self.settings.dm_policy == "allowlist":
            return any(
                allowed.lower() == handle.lower() for allowed in self.settings.allow_from
            )

        # pairing - allow and track
        return True

    def _parse_messages_result(self, result: str) -> list[IMessageMessage]:
        """Parse AppleScript messages result (tab-delimited)."""
        return parse_messages_from_applescript(result)

    def _parse_chats_result(self, result: str) -> list[IMessageChat]:
        """Parse AppleScript chats result (tab-delimited)."""
        return parse_chats_from_applescript(result)


def parse_messages_from_applescript(result: str) -> list[IMessageMessage]:
    """Parse tab-delimited AppleScript messages output.

    Expected format per line: "id\\ttext\\tdate_sent\\tis_from_me\\tchat_identifier\\tsender"
    """
    messages: list[IMessageMessage] = []
    if not result or not result.strip():
        return messages

    for line in result.split("\n"):
        trimmed = line.strip()
        if not trimmed:
            continue

        fields = trimmed.split("\t")
        if len(fields) < 6:
            continue

        msg_id = fields[0]
        text = fields[1]
        date_sent = fields[2]
        is_from_me_str = fields[3]
        chat_identifier = fields[4]
        sender = fields[5]

        is_from_me = is_from_me_str in ("1", "true", "True")

        # Parse timestamp: try int first, then ISO format, fallback to 0
        timestamp = 0
        try:
            timestamp = int(date_sent)
        except (ValueError, TypeError):
            try:
                from datetime import datetime, timezone

                dt = datetime.fromisoformat(date_sent)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                timestamp = int(dt.timestamp() * 1000)
            except (ValueError, TypeError):
                timestamp = 0

        messages.append(
            IMessageMessage(
                id=msg_id or "",
                text=text or "",
                handle=sender or "",
                chat_id=chat_identifier or "",
                timestamp=timestamp,
                is_from_me=is_from_me,
                has_attachments=False,
                attachment_paths=[],
            )
        )

    return messages


def parse_chats_from_applescript(result: str) -> list[IMessageChat]:
    """Parse tab-delimited AppleScript chats output.

    Expected format per line: "chat_identifier\\tdisplay_name\\tparticipant_count\\tlast_message_date"
    """
    chats: list[IMessageChat] = []
    if not result or not result.strip():
        return chats

    for line in result.split("\n"):
        trimmed = line.strip()
        if not trimmed:
            continue

        fields = trimmed.split("\t")
        if len(fields) < 4:
            continue

        chat_identifier = fields[0]
        display_name = fields[1]
        participant_count_str = fields[2]

        try:
            participant_count = int(participant_count_str)
        except (ValueError, TypeError):
            participant_count = 0

        chat_type = "group" if participant_count > 1 else "direct"

        chats.append(
            IMessageChat(
                chat_id=chat_identifier or "",
                chat_type=chat_type,
                display_name=display_name if display_name else None,
                participants=[],
            )
        )

    return chats
