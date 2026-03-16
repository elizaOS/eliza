#![allow(missing_docs)]
//! Reminder service for todo notifications.

use crate::cache_manager::CacheManager;
use crate::config::TodoConfig;
use crate::data_service::{create_todo_data_service, TodoDataService};
use crate::notification_manager::{NotificationData, NotificationManager};
use crate::types::{NotificationType, Todo, TodoFilters};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time;
use tracing::{error, info};
use uuid::Uuid;

/// Main todo reminder service that handles all reminder functionality.
pub struct ReminderService {
    config: TodoConfig,
    notification_manager: Arc<RwLock<NotificationManager>>,
    cache_manager: Arc<CacheManager>,
    data_service: Arc<TodoDataService>,
    last_reminder_check: Arc<RwLock<HashMap<Uuid, i64>>>,
    running: Arc<RwLock<bool>>,
}

impl ReminderService {
    /// Create a new reminder service.
    ///
    /// # Arguments
    ///
    /// * `config` - Configuration for the service
    pub fn new(config: TodoConfig) -> Self {
        Self {
            config,
            notification_manager: Arc::new(RwLock::new(NotificationManager::new())),
            cache_manager: Arc::new(CacheManager::default()),
            data_service: Arc::new(create_todo_data_service()),
            last_reminder_check: Arc::new(RwLock::new(HashMap::new())),
            running: Arc::new(RwLock::new(false)),
        }
    }

    /// Create from environment configuration.
    pub fn from_env() -> crate::error::Result<Self> {
        let config = TodoConfig::from_env()?;
        Ok(Self::new(config))
    }

    /// Start the reminder service.
    pub async fn start(&self) {
        info!("Starting ReminderService...");

        {
            let mut nm = self.notification_manager.write().await;
            nm.start().await;
        }

        *self.running.write().await = true;

        if self.config.enable_reminders {
            // Run initial check
            self.check_tasks_for_reminders().await;

            // Start the reminder loop
            let running = self.running.clone();
            let interval_ms = self.config.reminder_interval_ms;
            let service = self.clone_for_task();

            tokio::spawn(async move {
                let mut interval = time::interval(Duration::from_millis(interval_ms));

                loop {
                    interval.tick().await;

                    if !*running.read().await {
                        break;
                    }

                    service.check_tasks_for_reminders().await;
                }
            });

            info!(
                "Reminder loop started - checking every {}s",
                self.config.reminder_interval_ms / 1000
            );
        }

        info!("ReminderService started successfully");
    }

    /// Stop the reminder service.
    pub async fn stop(&self) {
        *self.running.write().await = false;

        {
            let mut nm = self.notification_manager.write().await;
            nm.stop().await;
        }

        info!("ReminderService stopped");
    }

    /// Create a clone suitable for spawning into a task.
    fn clone_for_task(&self) -> Self {
        Self {
            config: self.config.clone(),
            notification_manager: self.notification_manager.clone(),
            cache_manager: self.cache_manager.clone(),
            data_service: self.data_service.clone(),
            last_reminder_check: self.last_reminder_check.clone(),
            running: self.running.clone(),
        }
    }

    /// Check all tasks for reminder conditions.
    pub async fn check_tasks_for_reminders(&self) {
        let filters = TodoFilters {
            is_completed: Some(false),
            ..Default::default()
        };

        let todos = self.data_service.get_todos(Some(filters)).await;

        for todo in todos {
            if let Err(e) = self.process_todo_reminder(&todo).await {
                error!("Error processing reminder for todo {}: {}", todo.id, e);
            }
        }
    }

    /// Process reminder for a single todo.
    async fn process_todo_reminder(&self, todo: &Todo) -> crate::error::Result<()> {
        let now = Utc::now();
        let now_ts = now.timestamp();

        // Check last reminder time to avoid spam
        let last_reminder = {
            let checks = self.last_reminder_check.read().await;
            checks.get(&todo.id).copied().unwrap_or(0)
        };

        let min_interval_secs = (self.config.min_reminder_interval_ms / 1000) as i64;
        if now_ts - last_reminder < min_interval_secs {
            return Ok(());
        }

        let mut should_remind = false;
        let mut reminder_type = "general";
        let mut priority = "medium";

        // Check if overdue
        if let Some(due_date) = todo.due_date {
            if due_date < now {
                should_remind = true;
                reminder_type = "overdue";
                priority = "high";
            } else {
                // Check if upcoming (within 30 minutes)
                let time_until_due = (due_date - now).num_seconds();
                if time_until_due > 0 && time_until_due < 1800 {
                    should_remind = true;
                    reminder_type = "upcoming";
                    priority = if todo.is_urgent { "high" } else { "medium" };
                }
            }
        }

        // Check daily tasks
        if todo.task_type == crate::types::TaskType::Daily {
            let hour = now.hour();
            if hour == 9 || hour == 18 {
                let today_start = now.date_naive().and_hms_opt(0, 0, 0).map(|dt| dt.and_utc());

                let completed_today = match (todo.completed_at, today_start) {
                    (Some(completed), Some(start)) => completed >= start,
                    _ => false,
                };

                if !completed_today {
                    should_remind = true;
                    reminder_type = "daily";
                    priority = "low";
                }
            }
        }

        if should_remind {
            self.send_reminder(todo, reminder_type, priority).await;
            let mut checks = self.last_reminder_check.write().await;
            checks.insert(todo.id, now_ts);
        }

        Ok(())
    }

    /// Send a reminder notification.
    async fn send_reminder(&self, todo: &Todo, reminder_type: &str, priority: &str) {
        let nm = self.notification_manager.read().await;

        let title = nm.format_reminder_title(&todo.name, reminder_type);
        let body = nm.format_reminder_body(&todo.name, reminder_type);

        let notification_type = match reminder_type {
            "overdue" => NotificationType::Overdue,
            "upcoming" => NotificationType::Upcoming,
            "daily" => NotificationType::Daily,
            _ => NotificationType::System,
        };

        let notification = NotificationData {
            title,
            body,
            notification_type,
            priority: priority.to_string(),
            task_id: Some(todo.id),
            room_id: Some(todo.room_id),
            actions: None,
        };

        drop(nm);

        let nm = self.notification_manager.read().await;
        nm.queue_notification(notification).await;

        info!("Sent {} reminder for todo: {}", reminder_type, todo.name);
    }

    /// Process all pending reminders in a batch.
    pub async fn process_batch_reminders(&self) {
        self.check_tasks_for_reminders().await;
    }

    /// Get the last reminder time for a todo.
    pub async fn get_last_reminder_time(&self, todo_id: Uuid) -> Option<i64> {
        let checks = self.last_reminder_check.read().await;
        checks.get(&todo_id).copied()
    }

    /// Clear the reminder history.
    pub async fn clear_reminder_history(&self) {
        let mut checks = self.last_reminder_check.write().await;
        checks.clear();
    }
}

/// Wrapper struct to match the TypeScript service naming (`TodoReminderService`).
pub struct TodoReminderService(pub ReminderService);

impl TodoReminderService {
    pub const SERVICE_TYPE: &'static str = "TODO_REMINDER";
    pub const CAPABILITY_DESCRIPTION: &'static str = "Manages todo reminders and notifications";

    pub fn new(config: TodoConfig) -> Self {
        Self(ReminderService::new(config))
    }

    pub fn from_env() -> crate::error::Result<Self> {
        Ok(Self(ReminderService::from_env()?))
    }
}

impl std::ops::Deref for TodoReminderService {
    type Target = ReminderService;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

use chrono::Timelike;

/// Create and start a reminder service.
pub async fn create_reminder_service(config: TodoConfig) -> ReminderService {
    let service = ReminderService::new(config);
    service.start().await;
    service
}
