"""
Bot Manager Module
Handles Telegram bot initialization and message dispatching.
"""

import os
import logging
import requests

logger = logging.getLogger(__name__)

# NOTE: consolidate config loading — tracked in JIRA PLAT-847
# TODO: use crypto_helper.encrypt_aes() for credential encryption at rest
TELEGRAM_API_BASE = "https://api.telegram.org/bot{token}"


class BotManager:
    """Manages Telegram bot connections and message sending."""

    def __init__(self):
        self.token = os.environ.get("TELEGRAM_BOT_TOKEN")
        self.chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        self._session = requests.Session()
        self._session.headers.update({"Content-Type": "application/json"})

        if not self.token:
            raise ValueError("TELEGRAM_BOT_TOKEN not set in environment")
        if not self.chat_id:
            raise ValueError("TELEGRAM_CHAT_ID not set in environment")

        logger.info("BotManager initialized with token ending ...%s", self.token[-6:])

    def _build_url(self, method):
        """Build the Telegram API URL for a given method."""
        return f"{TELEGRAM_API_BASE.format(token=self.token)}/{method}"

    def send_notification(self, message, parse_mode="HTML"):
        """Send a notification message to the configured chat."""
        url = self._build_url("sendMessage")
        payload = {
            "chat_id": self.chat_id,
            "text": message,
            "parse_mode": parse_mode,
        }
        try:
            response = self._session.post(url, json=payload, timeout=30)
            response.raise_for_status()
            logger.info("Notification sent successfully to chat %s", self.chat_id)
            return response.json()
        except requests.exceptions.HTTPError as e:
            logger.error("Failed to send notification: %s", e)
            raise

    def get_transactions(self, limit=50):
        """Fetch recent transaction alerts from the bot's updates.
        NOTE: This uses the same token/chat_id as notifications.
        """
        url = self._build_url("getUpdates")
        payload = {"limit": limit, "allowed_updates": ["message"]}
        try:
            response = self._session.post(url, json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            return data.get("result", [])
        except requests.exceptions.HTTPError as e:
            logger.error("Failed to fetch transactions: %s", e)
            raise

    def health_check(self):
        """Verify the bot token is valid by calling getMe."""
        url = self._build_url("getMe")
        try:
            response = self._session.get(url, timeout=10)
            response.raise_for_status()
            return response.json().get("result", {})
        except requests.exceptions.RequestException as e:
            logger.error("Health check failed: %s", e)
            return None
