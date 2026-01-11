"""
Notification manager for handling todo notifications.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from elizaos_plugin_todo.types import NotificationType

logger = logging.getLogger(__name__)


@dataclass
class NotificationPreferences:
    """User notification preferences."""

    enabled: bool = True
    sound: bool = True
    browser_notifications: bool = False
    reminder_types: dict[str, bool] = field(
        default_factory=lambda: {
            "overdue": True,
            "upcoming": True,
            "daily": True,
        }
    )
    quiet_hours: dict[str, int] | None = field(default_factory=lambda: {"start": 22, "end": 8})


@dataclass
class NotificationData:
    """Notification data structure."""

    title: str
    body: str
    type: NotificationType
    priority: str = "medium"  # 'low' | 'medium' | 'high'
    task_id: UUID | None = None
    room_id: UUID | None = None
    actions: list[dict[str, str]] | None = None


class NotificationManager:
    """
    Manager for handling notifications across different channels.

    Features:
    - Queued notification delivery
    - User preference management
    - Quiet hours support
    - Multi-channel delivery (in-app, browser)
    """

    def __init__(self, runtime: Any | None = None) -> None:
        """
        Initialize the notification manager.

        Args:
            runtime: Optional runtime context
        """
        self._runtime = runtime
        self._user_preferences: dict[UUID, NotificationPreferences] = {}
        self._notification_queue: list[NotificationData] = []
        self._is_processing = False
        self._queue_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Start the notification manager."""
        self._queue_task = asyncio.create_task(self._process_queue_loop())
        logger.info("NotificationManager started")

    async def stop(self) -> None:
        """Stop the notification manager."""
        if self._queue_task:
            self._queue_task.cancel()
            try:
                await self._queue_task
            except asyncio.CancelledError:
                pass

        # Process remaining notifications
        await self._process_queue()
        logger.info("NotificationManager stopped")

    async def _process_queue_loop(self) -> None:
        """Background queue processing loop."""
        while True:
            try:
                await asyncio.sleep(1)
                await self._process_queue()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in notification queue processing: {e}")

    async def _process_queue(self) -> None:
        """Process queued notifications."""
        if self._is_processing or not self._notification_queue:
            return

        self._is_processing = True
        try:
            while self._notification_queue:
                notification = self._notification_queue.pop(0)
                await self._send_notification(notification)
        except Exception as e:
            logger.error(f"Error processing notification queue: {e}")
        finally:
            self._is_processing = False

    async def queue_notification(self, notification: NotificationData) -> None:
        """
        Queue a notification for delivery.

        Args:
            notification: Notification data to queue
        """
        # Check quiet hours
        if self._is_in_quiet_hours(notification.room_id):
            logger.debug(f"Notification queued for after quiet hours: {notification.title}")
            return

        self._notification_queue.append(notification)

    async def _send_notification(self, notification: NotificationData) -> None:
        """
        Send a notification through appropriate channels.

        Args:
            notification: Notification data to send
        """
        try:
            # Send in-app notification
            await self._send_in_app_notification(notification)

            # Send browser notification if enabled
            if self._should_send_browser_notification(notification):
                await self._send_browser_notification(notification)

            logger.info(
                f"Notification sent: {notification.title}",
                extra={
                    "type": notification.type.value,
                    "priority": notification.priority,
                },
            )
        except Exception as e:
            logger.error(f"Error sending notification: {e}")

    async def _send_in_app_notification(self, notification: NotificationData) -> None:
        """
        Send an in-app notification.

        Args:
            notification: Notification data
        """
        if not notification.room_id:
            return

        if self._runtime:
            # In a real implementation, this would emit an event
            # to the runtime for in-app notification display
            logger.debug(f"In-app notification: {notification.title} - {notification.body}")

    async def _send_browser_notification(self, notification: NotificationData) -> None:
        """
        Send a browser notification.

        Args:
            notification: Notification data
        """
        # Browser notifications would be handled by the frontend
        logger.debug(f"Browser notification would be sent: {notification.title}")

    def _should_send_browser_notification(self, notification: NotificationData) -> bool:
        """
        Check if browser notifications should be sent.

        Args:
            notification: Notification data

        Returns:
            True if browser notification should be sent
        """
        if not notification.room_id:
            return False

        prefs = self.get_user_preferences(notification.room_id)
        if not prefs.enabled or not prefs.browser_notifications:
            return False

        # Check if this type of reminder is enabled
        type_key = notification.type.value
        return prefs.reminder_types.get(type_key, False)

    def _is_in_quiet_hours(self, room_id: UUID | None) -> bool:
        """
        Check if we're in quiet hours.

        Args:
            room_id: Room ID for preference lookup

        Returns:
            True if in quiet hours
        """
        if not room_id:
            return False

        prefs = self.get_user_preferences(room_id)
        if not prefs.quiet_hours:
            return False

        now = datetime.now()
        current_hour = now.hour
        start = prefs.quiet_hours.get("start", 22)
        end = prefs.quiet_hours.get("end", 8)

        # Handle cases where quiet hours span midnight
        if start <= end:
            return start <= current_hour < end
        else:
            return current_hour >= start or current_hour < end

    def get_user_preferences(self, user_or_room_id: UUID) -> NotificationPreferences:
        """
        Get user preferences for notifications.

        Args:
            user_or_room_id: User or room UUID

        Returns:
            User's notification preferences
        """
        if user_or_room_id in self._user_preferences:
            return self._user_preferences[user_or_room_id]

        # Return default preferences
        defaults = NotificationPreferences()
        self._user_preferences[user_or_room_id] = defaults
        return defaults

    async def update_user_preferences(
        self,
        user_or_room_id: UUID,
        preferences: NotificationPreferences,
    ) -> None:
        """
        Update user notification preferences.

        Args:
            user_or_room_id: User or room UUID
            preferences: New preferences
        """
        self._user_preferences[user_or_room_id] = preferences
        # In a real implementation, this would persist to database
        logger.debug(f"Updated preferences for {user_or_room_id}")

    def format_reminder_title(self, todo_name: str, reminder_type: str) -> str:
        """
        Format a reminder notification title.

        Args:
            todo_name: Name of the todo
            reminder_type: Type of reminder

        Returns:
            Formatted title string
        """
        if reminder_type == "overdue":
            return f"⚠️ OVERDUE: {todo_name}"
        elif reminder_type == "upcoming":
            return f"⏰ REMINDER: {todo_name}"
        elif reminder_type == "daily":
            return "📅 Daily Reminder"
        else:
            return f"📋 Reminder: {todo_name}"

    def format_reminder_body(self, todo_name: str, reminder_type: str) -> str:
        """
        Format a reminder notification body.

        Args:
            todo_name: Name of the todo
            reminder_type: Type of reminder

        Returns:
            Formatted body string
        """
        if reminder_type == "overdue":
            return f'Your task "{todo_name}" is overdue. Please complete it when possible.'
        elif reminder_type == "upcoming":
            return f'Your task "{todo_name}" is due soon. Don\'t forget to complete it!'
        elif reminder_type == "daily":
            return "Don't forget to complete your daily tasks today!"
        else:
            return f"Reminder about your task: {todo_name}"





