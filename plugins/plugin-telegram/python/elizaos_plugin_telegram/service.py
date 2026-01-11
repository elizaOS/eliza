"""Telegram service implementation."""

import logging
from typing import Callable

from telegram import Bot, Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from elizaos_plugin_telegram.config import TelegramConfig
from elizaos_plugin_telegram.error import BotNotInitializedError, MessageSendError
from elizaos_plugin_telegram.types import (
    TelegramChat,
    TelegramContent,
    TelegramEventType,
    TelegramMessagePayload,
    TelegramUser,
)

logger = logging.getLogger(__name__)


class TelegramService:
    """Telegram bot service for elizaOS agents.

    This service handles all Telegram-specific functionality including:
    - Initializing and managing the Telegram bot
    - Handling message events
    - Managing forum topics as separate rooms
    """

    def __init__(self, config: TelegramConfig) -> None:
        """Initialize the Telegram service.

        Args:
            config: Telegram configuration
        """
        self.config = config
        self._application: Application | None = None  # type: ignore[type-arg]
        self._bot: Bot | None = None
        self._running = False
        self._message_handlers: list[Callable[[TelegramMessagePayload], None]] = []
        self._event_handlers: dict[TelegramEventType, list[Callable[..., None]]] = {}

    @property
    def bot(self) -> Bot:
        """Get the bot instance.

        Returns:
            The Telegram bot instance

        Raises:
            BotNotInitializedError: If bot is not initialized
        """
        if self._bot is None:
            raise BotNotInitializedError()
        return self._bot

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._running

    async def start(self) -> None:
        """Start the Telegram bot.

        Initializes the bot application and starts polling for updates.
        """
        logger.info("Starting Telegram service...")

        self._application = (
            Application.builder()
            .token(self.config.bot_token)
            .base_url(f"{self.config.api_root}/bot")
            .build()
        )
        self._bot = self._application.bot

        # Register handlers
        self._application.add_handler(CommandHandler("start", self._handle_start))
        self._application.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_message)
        )

        # Initialize and start
        await self._application.initialize()
        await self._application.start()
        await self._application.updater.start_polling(drop_pending_updates=True)  # type: ignore[union-attr]

        self._running = True
        logger.info("Telegram service started successfully")

    async def stop(self) -> None:
        """Stop the Telegram bot."""
        if self._application and self._running:
            logger.info("Stopping Telegram service...")
            await self._application.updater.stop()  # type: ignore[union-attr]
            await self._application.stop()
            await self._application.shutdown()
            self._running = False
            logger.info("Telegram service stopped")

    def on_message(self, handler: Callable[[TelegramMessagePayload], None]) -> None:
        """Register a message handler.

        Args:
            handler: Callback function for incoming messages
        """
        self._message_handlers.append(handler)

    def on_event(
        self, event_type: TelegramEventType, handler: Callable[..., None]
    ) -> None:
        """Register an event handler.

        Args:
            event_type: The event type to listen for
            handler: Callback function for the event
        """
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def send_message(
        self,
        chat_id: int | str,
        content: TelegramContent,
    ) -> None:
        """Send a message to a chat.

        Args:
            chat_id: The target chat ID
            content: The message content

        Raises:
            BotNotInitializedError: If bot is not initialized
            MessageSendError: If message sending fails
        """
        if self._bot is None:
            raise BotNotInitializedError()

        try:
            # Build inline keyboard if buttons are present
            reply_markup = None
            if content.buttons:
                from telegram import InlineKeyboardButton, InlineKeyboardMarkup

                keyboard = []
                for button in content.buttons:
                    keyboard.append(
                        [InlineKeyboardButton(text=button.text, url=button.url)]
                    )
                reply_markup = InlineKeyboardMarkup(keyboard)

            await self._bot.send_message(
                chat_id=chat_id,
                text=content.text or "",
                reply_markup=reply_markup,
            )
        except Exception as e:
            raise MessageSendError(str(chat_id), e) from e

    async def _handle_start(self, update: Update, _context: object) -> None:
        """Handle /start command.

        Args:
            update: The update object
            _context: The callback context (unused)
        """
        self._emit_event(TelegramEventType.SLASH_START, update)

    async def _handle_message(self, update: Update, _context: object) -> None:
        """Handle incoming messages.

        Args:
            update: The update object
            _context: The callback context (unused)
        """
        if not update.message:
            return

        message = update.message
        chat = message.chat
        user = message.from_user

        # Check authorization
        if not self.config.is_chat_allowed(str(chat.id)):
            logger.debug("Chat %s not authorized, skipping message", chat.id)
            return

        # Build payload
        payload = TelegramMessagePayload(
            message_id=message.message_id,
            chat=TelegramChat(
                id=chat.id,
                type=chat.type,  # type: ignore[arg-type]
                title=chat.title,
                username=chat.username,
                first_name=chat.first_name,
                is_forum=getattr(chat, "is_forum", False),
            ),
            from_user=TelegramUser(
                id=user.id,
                username=user.username,
                first_name=user.first_name,
                last_name=user.last_name,
                is_bot=user.is_bot,
            )
            if user
            else None,
            text=message.text,
            date=int(message.date.timestamp()),
            thread_id=message.message_thread_id,
        )

        # Notify handlers
        for handler in self._message_handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in message handler")

        self._emit_event(TelegramEventType.MESSAGE_RECEIVED, payload)

    def _emit_event(self, event_type: TelegramEventType, payload: object) -> None:
        """Emit an event to registered handlers.

        Args:
            event_type: The event type
            payload: The event payload
        """
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)
