import logging
import time
from collections.abc import Callable

from telegram import Bot, ReactionTypeEmoji, Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from elizaos_plugin_telegram.config import TelegramConfig
from elizaos_plugin_telegram.error import BotNotInitializedError, MessageSendError
from elizaos_plugin_telegram.types import (
    SendReactionParams,
    SendReactionResult,
    TelegramBotInfo,
    TelegramBotProbe,
    TelegramBotStatusPayload,
    TelegramChat,
    TelegramContent,
    TelegramEventType,
    TelegramMessagePayload,
    TelegramUser,
    TelegramWebhookInfo,
    TelegramWebhookPayload,
)

logger = logging.getLogger(__name__)


class TelegramService:
    def __init__(self, config: TelegramConfig) -> None:
        self.config = config
        self._application: Application | None = None  # type: ignore[type-arg]
        self._bot: Bot | None = None
        self._running = False
        self._bot_info: TelegramBotInfo | None = None
        self._message_handlers: list[Callable[[TelegramMessagePayload], None]] = []
        self._event_handlers: dict[TelegramEventType, list[Callable[..., None]]] = {}

    @property
    def bot(self) -> Bot:
        if self._bot is None:
            raise BotNotInitializedError()
        return self._bot

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def bot_info(self) -> TelegramBotInfo | None:
        return self._bot_info

    async def start(self) -> None:
        logger.info("Starting Telegram service...")

        builder = (
            Application.builder()
            .token(self.config.bot_token)
            .base_url(f"{self.config.api_root}/bot")
        )
        
        # Configure proxy if set
        if self.config.proxy_url:
            builder = builder.proxy(self.config.proxy_url)
        
        self._application = builder.build()
        self._bot = self._application.bot

        # Get bot info
        me = await self._bot.get_me()
        self._bot_info = TelegramBotInfo(
            id=me.id,
            username=me.username,
            first_name=me.first_name,
            can_join_groups=me.can_join_groups or False,
            can_read_all_group_messages=me.can_read_all_group_messages or False,
            supports_inline_queries=me.supports_inline_queries or False,
        )
        logger.info("Bot connected: @%s (ID: %s)", me.username, me.id)

        self._application.add_handler(CommandHandler("start", self._handle_start))
        self._application.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_message)
        )

        await self._application.initialize()
        await self._application.start()

        # Start based on update mode
        if self.config.update_mode == "webhook" and self.config.webhook_url:
            await self._start_webhook()
        else:
            await self._start_polling()

        self._running = True
        
        # Emit bot started event
        self._emit_event(
            TelegramEventType.BOT_STARTED,
            TelegramBotStatusPayload(
                bot_id=self._bot_info.id,
                bot_username=self._bot_info.username,
                bot_name=self._bot_info.first_name,
                update_mode=self.config.update_mode,
                timestamp=int(time.time() * 1000),
            ),
        )
        
        logger.info("Telegram service started successfully in %s mode", self.config.update_mode)

    async def _start_polling(self) -> None:
        """Start long-polling for updates."""
        if self._application and self._application.updater:
            await self._application.updater.start_polling(
                drop_pending_updates=self.config.drop_pending_updates,
                allowed_updates=["message", "message_reaction", "chat_member", "my_chat_member"],
            )
            logger.info("Polling started (drop_pending_updates=%s)", self.config.drop_pending_updates)

    async def _start_webhook(self) -> None:
        """Start webhook mode for updates."""
        if not self._application or not self.config.webhook_url:
            raise ValueError("Application or webhook URL not configured")
        
        full_url = f"{self.config.webhook_url}{self.config.webhook_path}"
        
        await self._bot.set_webhook(  # type: ignore[union-attr]
            url=full_url,
            secret_token=self.config.webhook_secret,
            allowed_updates=["message", "message_reaction", "chat_member", "my_chat_member"],
            drop_pending_updates=self.config.drop_pending_updates,
        )
        
        # Start the webhook server
        port = self.config.webhook_port or 8443
        
        await self._application.updater.start_webhook(  # type: ignore[union-attr]
            listen="0.0.0.0",
            port=port,
            url_path=self.config.webhook_path.lstrip("/"),
            webhook_url=full_url,
            secret_token=self.config.webhook_secret,
            drop_pending_updates=self.config.drop_pending_updates,
        )
        
        self._emit_event(
            TelegramEventType.WEBHOOK_REGISTERED,
            TelegramWebhookPayload(
                url=full_url,
                path=self.config.webhook_path,
                port=port,
                has_secret=bool(self.config.webhook_secret),
                timestamp=int(time.time() * 1000),
            ),
        )
        
        logger.info("Webhook started at %s (port %d)", full_url, port)

    async def stop(self) -> None:
        if self._application and self._running:
            logger.info("Stopping Telegram service...")
            
            # Emit bot stopped event
            self._emit_event(
                TelegramEventType.BOT_STOPPED,
                TelegramBotStatusPayload(
                    bot_id=self._bot_info.id if self._bot_info else None,
                    bot_username=self._bot_info.username if self._bot_info else None,
                    bot_name=self._bot_info.first_name if self._bot_info else None,
                    update_mode=self.config.update_mode,
                    timestamp=int(time.time() * 1000),
                ),
            )
            
            if self._application.updater:
                await self._application.updater.stop()
            await self._application.stop()
            await self._application.shutdown()
            self._running = False
            logger.info("Telegram service stopped")

    async def probe_telegram(self, timeout_s: float = 5.0) -> TelegramBotProbe:
        """Probe the Telegram bot connection for health checks."""
        if self._bot is None:
            return TelegramBotProbe(
                ok=False,
                error="Bot not initialized",
                latency_ms=0,
            )
        
        start_time = time.time()
        try:
            me = await self._bot.get_me()
            latency_ms = int((time.time() - start_time) * 1000)
            
            return TelegramBotProbe(
                ok=True,
                bot=TelegramBotInfo(
                    id=me.id,
                    username=me.username,
                    first_name=me.first_name,
                    can_join_groups=me.can_join_groups or False,
                    can_read_all_group_messages=me.can_read_all_group_messages or False,
                    supports_inline_queries=me.supports_inline_queries or False,
                ),
                latency_ms=latency_ms,
            )
        except Exception as e:
            latency_ms = int((time.time() - start_time) * 1000)
            return TelegramBotProbe(
                ok=False,
                error=str(e),
                latency_ms=latency_ms,
            )

    async def send_reaction(self, params: SendReactionParams) -> SendReactionResult:
        """Send a reaction to a message."""
        if self._bot is None:
            return SendReactionResult(
                success=False,
                chat_id=params.chat_id,
                message_id=params.message_id,
                reaction=params.reaction,
                error="Bot not initialized",
            )
        
        try:
            chat_id = int(params.chat_id) if isinstance(params.chat_id, str) else params.chat_id
            
            reaction = ReactionTypeEmoji(emoji=params.reaction)
            
            await self._bot.set_message_reaction(
                chat_id=chat_id,
                message_id=params.message_id,
                reaction=[reaction],
                is_big=params.is_big,
            )
            
            self._emit_event(
                TelegramEventType.REACTION_SENT,
                {
                    "chat_id": params.chat_id,
                    "message_id": params.message_id,
                    "reaction": params.reaction,
                    "success": True,
                },
            )
            
            return SendReactionResult(
                success=True,
                chat_id=params.chat_id,
                message_id=params.message_id,
                reaction=params.reaction,
            )
        except Exception as e:
            logger.exception("Failed to send reaction")
            return SendReactionResult(
                success=False,
                chat_id=params.chat_id,
                message_id=params.message_id,
                reaction=params.reaction,
                error=str(e),
            )

    async def remove_reaction(self, chat_id: int | str, message_id: int) -> SendReactionResult:
        """Remove a reaction from a message."""
        if self._bot is None:
            return SendReactionResult(
                success=False,
                chat_id=chat_id,
                message_id=message_id,
                reaction="",
                error="Bot not initialized",
            )
        
        try:
            numeric_chat_id = int(chat_id) if isinstance(chat_id, str) else chat_id
            
            await self._bot.set_message_reaction(
                chat_id=numeric_chat_id,
                message_id=message_id,
                reaction=[],
            )
            
            return SendReactionResult(
                success=True,
                chat_id=chat_id,
                message_id=message_id,
                reaction="",
            )
        except Exception as e:
            logger.exception("Failed to remove reaction")
            return SendReactionResult(
                success=False,
                chat_id=chat_id,
                message_id=message_id,
                reaction="",
                error=str(e),
            )

    async def delete_webhook(self) -> bool:
        """Delete the current webhook and switch to polling mode."""
        if self._bot is None:
            return False
        
        try:
            await self._bot.delete_webhook(drop_pending_updates=True)
            logger.info("Webhook deleted successfully")
            return True
        except Exception:
            logger.exception("Failed to delete webhook")
            return False

    async def get_webhook_info(self) -> TelegramWebhookInfo | None:
        """Get current webhook information."""
        if self._bot is None:
            return None
        
        try:
            info = await self._bot.get_webhook_info()
            return TelegramWebhookInfo(
                url=info.url or "",
                has_custom_certificate=info.has_custom_certificate,
                pending_update_count=info.pending_update_count,
                last_error_date=info.last_error_date,
                last_error_message=info.last_error_message,
                max_connections=info.max_connections,
                allowed_updates=list(info.allowed_updates) if info.allowed_updates else None,
            )
        except Exception:
            logger.exception("Failed to get webhook info")
            return None

    def on_message(self, handler: Callable[[TelegramMessagePayload], None]) -> None:
        self._message_handlers.append(handler)

    def on_event(self, event_type: TelegramEventType, handler: Callable[..., None]) -> None:
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def send_message(
        self,
        chat_id: int | str,
        content: TelegramContent,
        reply_to_message_id: int | None = None,
        message_thread_id: int | None = None,
    ) -> int | None:
        """Send a message to a chat.
        
        Returns the message ID of the sent message, or None on failure.
        """
        if self._bot is None:
            raise BotNotInitializedError()

        try:
            reply_markup = None
            if content.buttons:
                from telegram import InlineKeyboardButton, InlineKeyboardMarkup

                keyboard = []
                for button in content.buttons:
                    keyboard.append([InlineKeyboardButton(text=button.text, url=button.url)])
                reply_markup = InlineKeyboardMarkup(keyboard)

            msg = await self._bot.send_message(
                chat_id=chat_id,
                text=content.text or "",
                reply_markup=reply_markup,
                reply_to_message_id=reply_to_message_id,
                message_thread_id=message_thread_id,
            )
            return msg.message_id
        except Exception as e:
            raise MessageSendError(str(chat_id), e) from e

    async def _handle_start(self, update: Update, _context: object) -> None:
        self._emit_event(TelegramEventType.SLASH_START, update)

    async def _handle_message(self, update: Update, _context: object) -> None:
        if not update.message:
            return

        message = update.message
        chat = message.chat
        user = message.from_user

        if not self.config.is_chat_allowed(str(chat.id)):
            logger.debug("Chat %s not authorized, skipping message", chat.id)
            return

        # Check if we should ignore bot messages
        if user and user.is_bot and self.config.should_ignore_bot_messages:
            logger.debug("Ignoring bot message from %s", user.username)
            return

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

        for handler in self._message_handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in message handler")

        self._emit_event(TelegramEventType.MESSAGE_RECEIVED, payload)

    def _emit_event(self, event_type: TelegramEventType, payload: object) -> None:
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)
