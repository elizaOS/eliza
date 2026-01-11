"""
Reminder service for todo notifications.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any
from uuid import UUID

from elizaos_plugin_todo.cache_manager import CacheManager
from elizaos_plugin_todo.config import TodoConfig
from elizaos_plugin_todo.data_service import TodoDataService, create_todo_data_service
from elizaos_plugin_todo.notification_manager import NotificationData, NotificationManager
from elizaos_plugin_todo.types import NotificationType, Todo

logger = logging.getLogger(__name__)


class ReminderService:
    """
    Main todo reminder service that handles all reminder functionality.

    Features:
    - Periodic reminder checks
    - Overdue task detection
    - Upcoming task reminders
    - Daily task reminders
    - Rate limiting to prevent spam
    """

    def __init__(
        self,
        config: TodoConfig | None = None,
        runtime: Any | None = None,
    ) -> None:
        """
        Initialize the reminder service.

        Args:
            config: Optional configuration
            runtime: Optional runtime context
        """
        self._config = config or TodoConfig.from_env()
        self._runtime = runtime
        self._notification_manager: NotificationManager | None = None
        self._cache_manager: CacheManager | None = None
        self._data_service: TodoDataService | None = None
        self._reminder_task: asyncio.Task[None] | None = None
        self._last_reminder_check: dict[UUID, float] = {}

    async def start(self) -> None:
        """Start the reminder service."""
        logger.info("Starting ReminderService...")

        # Initialize managers
        self._notification_manager = NotificationManager(self._runtime)
        await self._notification_manager.start()

        self._cache_manager = CacheManager()
        await self._cache_manager.start()

        self._data_service = create_todo_data_service()

        # Start reminder loop
        if self._config.enable_reminders:
            self._reminder_task = asyncio.create_task(self._reminder_loop())
            logger.info(
                f"Reminder loop started - checking every "
                f"{self._config.reminder_interval_ms / 1000}s"
            )

        logger.info("ReminderService started successfully")

    async def stop(self) -> None:
        """Stop the reminder service."""
        if self._reminder_task:
            self._reminder_task.cancel()
            try:
                await self._reminder_task
            except asyncio.CancelledError:
                pass

        if self._notification_manager:
            await self._notification_manager.stop()

        if self._cache_manager:
            await self._cache_manager.stop()

        logger.info("ReminderService stopped")

    async def _reminder_loop(self) -> None:
        """Background reminder checking loop."""
        # Run immediately on start
        await self.check_tasks_for_reminders()

        while True:
            try:
                await asyncio.sleep(self._config.reminder_interval_ms / 1000)
                await self.check_tasks_for_reminders()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in reminder loop: {e}")

    async def check_tasks_for_reminders(self) -> None:
        """Check all tasks for reminder conditions."""
        if not self._data_service:
            return

        try:
            from elizaos_plugin_todo.types import TodoFilters

            # Get all incomplete todos
            filters = TodoFilters(is_completed=False)
            todos = await self._data_service.get_todos(filters)

            for todo in todos:
                try:
                    await self._process_todo_reminder(todo)
                except Exception as e:
                    logger.error(f"Error processing reminder for todo {todo.id}: {e}")

        except Exception as e:
            logger.error(f"Error checking tasks for reminders: {e}")

    async def _process_todo_reminder(self, todo: Todo) -> None:
        """
        Process reminder for a single todo.

        Args:
            todo: The todo to process
        """
        now = datetime.utcnow()
        should_remind = False
        reminder_type = "general"
        priority = "medium"

        # Check last reminder time to avoid spam
        last_reminder = self._last_reminder_check.get(todo.id, 0)
        time_since_last = now.timestamp() - last_reminder
        min_interval = self._config.min_reminder_interval_ms / 1000

        if time_since_last < min_interval:
            return  # Skip if we reminded recently

        # Check if overdue
        if todo.due_date and todo.due_date < now:
            should_remind = True
            reminder_type = "overdue"
            priority = "high"

        # Check if upcoming (within 30 minutes)
        elif todo.due_date:
            time_until_due = (todo.due_date - now).total_seconds()
            if 0 < time_until_due < 1800:  # 30 minutes
                should_remind = True
                reminder_type = "upcoming"
                priority = "high" if todo.is_urgent else "medium"

        # Check daily tasks (remind in morning and evening)
        elif todo.type.value == "daily":
            hour = now.hour
            if hour in (9, 18):  # 9 AM and 6 PM
                # Check if completed today
                today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
                if not todo.completed_at or todo.completed_at < today_start:
                    should_remind = True
                    reminder_type = "daily"
                    priority = "low"

        if should_remind:
            await self._send_reminder(todo, reminder_type, priority)
            self._last_reminder_check[todo.id] = now.timestamp()

    async def _send_reminder(
        self,
        todo: Todo,
        reminder_type: str,
        priority: str,
    ) -> None:
        """
        Send a reminder notification.

        Args:
            todo: The todo to remind about
            reminder_type: Type of reminder
            priority: Priority level
        """
        if not self._notification_manager:
            return

        try:
            title = self._notification_manager.format_reminder_title(todo.name, reminder_type)
            body = self._notification_manager.format_reminder_body(todo.name, reminder_type)

            notification = NotificationData(
                title=title,
                body=body,
                type=NotificationType(reminder_type)
                if reminder_type in ("overdue", "upcoming", "daily")
                else NotificationType.SYSTEM,
                priority=priority,
                task_id=todo.id,
                room_id=todo.room_id,
            )

            await self._notification_manager.queue_notification(notification)
            logger.info(f"Sent {reminder_type} reminder for todo: {todo.name}")

        except Exception as e:
            logger.error(f"Error sending reminder for todo {todo.id}: {e}")

    async def process_batch_reminders(self) -> None:
        """Process all pending reminders in a batch."""
        await self.check_tasks_for_reminders()

    def get_last_reminder_time(self, todo_id: UUID) -> float | None:
        """
        Get the last reminder time for a todo.

        Args:
            todo_id: The todo's UUID

        Returns:
            Timestamp of last reminder, or None
        """
        return self._last_reminder_check.get(todo_id)

    def clear_reminder_history(self) -> None:
        """Clear the reminder history."""
        self._last_reminder_check.clear()


async def create_reminder_service(
    config: TodoConfig | None = None,
    runtime: Any | None = None,
) -> ReminderService:
    """
    Create and start a reminder service.

    Args:
        config: Optional configuration
        runtime: Optional runtime context

    Returns:
        Started ReminderService instance
    """
    service = ReminderService(config, runtime)
    await service.start()
    return service





