#![allow(missing_docs)]
//! Notification manager for handling todo notifications.

use crate::types::NotificationType;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// User notification preferences.
#[derive(Debug, Clone)]
pub struct NotificationPreferences {
    /// Whether notifications are enabled
    pub enabled: bool,
    /// Whether to play sounds
    pub sound: bool,
    /// Whether to show browser notifications
    pub browser_notifications: bool,
    /// Which reminder types are enabled
    pub reminder_types: HashMap<String, bool>,
    /// Quiet hours (start, end)
    pub quiet_hours: Option<(u8, u8)>,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        let mut reminder_types = HashMap::new();
        reminder_types.insert("overdue".to_string(), true);
        reminder_types.insert("upcoming".to_string(), true);
        reminder_types.insert("daily".to_string(), true);

        Self {
            enabled: true,
            sound: true,
            browser_notifications: false,
            reminder_types,
            quiet_hours: Some((22, 8)),
        }
    }
}

/// Notification data structure.
#[derive(Debug, Clone)]
pub struct NotificationData {
    /// Notification title
    pub title: String,
    /// Notification body
    pub body: String,
    /// Notification type
    pub notification_type: NotificationType,
    /// Priority level
    pub priority: String,
    /// Associated task ID
    pub task_id: Option<Uuid>,
    /// Associated room ID
    pub room_id: Option<Uuid>,
    /// Action buttons
    pub actions: Option<Vec<NotificationAction>>,
}

/// Notification action button.
#[derive(Debug, Clone)]
pub struct NotificationAction {
    /// Button label
    pub label: String,
    /// Action identifier
    pub action: String,
}

/// Manager for handling notifications across different channels.
pub struct NotificationManager {
    user_preferences: Arc<RwLock<HashMap<Uuid, NotificationPreferences>>>,
    notification_tx: Option<mpsc::Sender<NotificationData>>,
    notification_rx: Option<mpsc::Receiver<NotificationData>>,
}

impl Default for NotificationManager {
    fn default() -> Self {
        Self::new()
    }
}

impl NotificationManager {
    /// Create a new notification manager.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel(100);
        Self {
            user_preferences: Arc::new(RwLock::new(HashMap::new())),
            notification_tx: Some(tx),
            notification_rx: Some(rx),
        }
    }

    /// Start the notification manager.
    pub async fn start(&mut self) {
        info!("NotificationManager started");
    }

    /// Stop the notification manager.
    pub async fn stop(&mut self) {
        self.notification_tx = None;
        self.notification_rx = None;
        info!("NotificationManager stopped");
    }

    /// Queue a notification for delivery.
    ///
    /// # Arguments
    ///
    /// * `notification` - Notification data to queue
    pub async fn queue_notification(&self, notification: NotificationData) {
        // Check quiet hours
        if self.is_in_quiet_hours(notification.room_id).await {
            debug!(
                "Notification queued for after quiet hours: {}",
                notification.title
            );
            return;
        }

        if let Some(ref tx) = self.notification_tx {
            if let Err(e) = tx.send(notification.clone()).await {
                warn!("Failed to queue notification: {}", e);
            }
        }

        // Send immediately in this implementation
        self.send_notification(&notification).await;
    }

    /// Send a notification.
    async fn send_notification(&self, notification: &NotificationData) {
        // Send in-app notification
        self.send_in_app_notification(notification).await;

        // Send browser notification if enabled
        if self.should_send_browser_notification(notification).await {
            self.send_browser_notification(notification).await;
        }

        info!(
            "Notification sent: {} (type: {:?}, priority: {})",
            notification.title, notification.notification_type, notification.priority
        );
    }

    /// Send an in-app notification.
    async fn send_in_app_notification(&self, notification: &NotificationData) {
        if notification.room_id.is_none() {
            return;
        }

        debug!(
            "In-app notification: {} - {}",
            notification.title, notification.body
        );
    }

    /// Send a browser notification.
    async fn send_browser_notification(&self, notification: &NotificationData) {
        debug!("Browser notification would be sent: {}", notification.title);
    }

    /// Check if browser notifications should be sent.
    async fn should_send_browser_notification(&self, notification: &NotificationData) -> bool {
        let room_id = match notification.room_id {
            Some(id) => id,
            None => return false,
        };

        let prefs = self.get_user_preferences(room_id).await;
        if !prefs.enabled || !prefs.browser_notifications {
            return false;
        }

        let type_key = match notification.notification_type {
            NotificationType::Overdue => "overdue",
            NotificationType::Upcoming => "upcoming",
            NotificationType::Daily => "daily",
            NotificationType::System => return true,
        };

        prefs.reminder_types.get(type_key).copied().unwrap_or(false)
    }

    /// Check if we're in quiet hours.
    async fn is_in_quiet_hours(&self, room_id: Option<Uuid>) -> bool {
        let room_id = match room_id {
            Some(id) => id,
            None => return false,
        };

        let prefs = self.get_user_preferences(room_id).await;
        let (start, end) = match prefs.quiet_hours {
            Some(hours) => hours,
            None => return false,
        };

        let now = chrono::Local::now();
        let current_hour = now.hour() as u8;

        if start <= end {
            current_hour >= start && current_hour < end
        } else {
            current_hour >= start || current_hour < end
        }
    }

    /// Get user preferences for notifications.
    pub async fn get_user_preferences(&self, user_or_room_id: Uuid) -> NotificationPreferences {
        let prefs = self.user_preferences.read().await;
        prefs.get(&user_or_room_id).cloned().unwrap_or_default()
    }

    /// Update user notification preferences.
    pub async fn update_user_preferences(
        &self,
        user_or_room_id: Uuid,
        preferences: NotificationPreferences,
    ) {
        let mut prefs = self.user_preferences.write().await;
        prefs.insert(user_or_room_id, preferences);
        debug!("Updated preferences for {}", user_or_room_id);
    }

    /// Format a reminder notification title.
    pub fn format_reminder_title(&self, todo_name: &str, reminder_type: &str) -> String {
        match reminder_type {
            "overdue" => format!("⚠️ OVERDUE: {}", todo_name),
            "upcoming" => format!("⏰ REMINDER: {}", todo_name),
            "daily" => "📅 Daily Reminder".to_string(),
            _ => format!("📋 Reminder: {}", todo_name),
        }
    }

    /// Format a reminder notification body.
    pub fn format_reminder_body(&self, todo_name: &str, reminder_type: &str) -> String {
        match reminder_type {
            "overdue" => format!(
                "Your task \"{}\" is overdue. Please complete it when possible.",
                todo_name
            ),
            "upcoming" => format!(
                "Your task \"{}\" is due soon. Don't forget to complete it!",
                todo_name
            ),
            "daily" => "Don't forget to complete your daily tasks today!".to_string(),
            _ => format!("Reminder about your task: {}", todo_name),
        }
    }
}

use chrono::Timelike;
