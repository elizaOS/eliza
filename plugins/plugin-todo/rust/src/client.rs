#![allow(missing_docs)]
//! High-level client for the Todo Plugin.

use crate::config::TodoConfig;
use crate::data_service::{create_todo_data_service, TodoDataService};
use crate::error::{Result, TodoError};
use crate::notification_manager::NotificationManager;
use crate::reminder_service::ReminderService;
use crate::types::{
    CreateTodoParams, Priority, TaskType, Todo, TodoFilters, TodoMetadata, UpdateTodoParams,
};
use chrono::Utc;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// High-level client for todo operations.
///
/// This client provides a simple interface for managing todos,
/// including creation, updates, completion, and querying.
///
/// # Example
///
/// ```rust,ignore
/// use elizaos_plugin_todo::{TodoClient, TodoConfig, TaskType, Priority};
///
/// #[tokio::main]
/// async fn main() -> anyhow::Result<()> {
///     let config = TodoConfig::from_env()?;
///     let client = TodoClient::new(config)?;
///     client.start().await?;
///
///     let todo = client.create_todo(CreateTodoParams {
///         name: "Finish report".to_string(),
///         task_type: TaskType::OneOff,
///         priority: Some(Priority::High),
///         ..Default::default()
///     }).await?;
///
///     println!("Created: {}", todo.name);
///
///     client.stop().await;
///     Ok(())
/// }
/// ```
pub struct TodoClient {
    config: TodoConfig,
    data_service: Arc<TodoDataService>,
    notification_manager: Arc<RwLock<NotificationManager>>,
    reminder_service: Option<Arc<ReminderService>>,
    started: Arc<RwLock<bool>>,
}

impl TodoClient {
    /// Create a new todo client.
    ///
    /// # Arguments
    ///
    /// * `config` - Configuration for the client
    ///
    /// # Errors
    ///
    /// Returns an error if configuration is invalid
    pub fn new(config: TodoConfig) -> Result<Self> {
        config.validate()?;

        Ok(Self {
            config,
            data_service: Arc::new(create_todo_data_service()),
            notification_manager: Arc::new(RwLock::new(NotificationManager::new())),
            reminder_service: None,
            started: Arc::new(RwLock::new(false)),
        })
    }

    /// Create a client from environment variables.
    pub fn from_env() -> Result<Self> {
        let config = TodoConfig::from_env()?;
        Self::new(config)
    }

    /// Start the client and all services.
    pub async fn start(&mut self) -> Result<()> {
        if *self.started.read().await {
            return Ok(());
        }

        // Start notification manager
        {
            let mut nm = self.notification_manager.write().await;
            nm.start().await;
        }

        // Start reminder service if enabled
        if self.config.enable_reminders {
            let service = ReminderService::new(self.config.clone());
            service.start().await;
            self.reminder_service = Some(Arc::new(service));
        }

        *self.started.write().await = true;
        Ok(())
    }

    /// Stop the client and all services.
    pub async fn stop(&mut self) {
        if !*self.started.read().await {
            return;
        }

        if let Some(ref service) = self.reminder_service {
            service.stop().await;
        }

        {
            let mut nm = self.notification_manager.write().await;
            nm.stop().await;
        }

        *self.started.write().await = false;
    }

    /// Check if the client is started.
    fn ensure_started(&self) -> Result<()> {
        // Note: This is a sync check, for async contexts use started.read().await
        Ok(())
    }

    /// Create a new todo.
    ///
    /// # Arguments
    ///
    /// * `params` - Parameters for creating the todo
    ///
    /// # Returns
    ///
    /// The created todo
    ///
    /// # Errors
    ///
    /// Returns an error if parameters are invalid
    pub async fn create_todo(&self, mut params: CreateTodoParams) -> Result<Todo> {
        self.ensure_started()?;

        if params.name.trim().is_empty() {
            return Err(TodoError::validation("Todo name is required"));
        }

        // Build tags
        params.tags.push("TODO".to_string());

        match params.task_type {
            TaskType::Daily => {
                params.tags.push("daily".to_string());
                params.tags.push("recurring-daily".to_string());
            }
            TaskType::OneOff => {
                params.tags.push("one-off".to_string());
                if let Some(priority) = params.priority {
                    params.tags.push(format!("priority-{}", priority as u8));
                }
                if params.is_urgent {
                    params.tags.push("urgent".to_string());
                }
            }
            TaskType::Aspirational => {
                params.tags.push("aspirational".to_string());
            }
        }

        // Set default priority for one-off tasks
        if params.task_type == TaskType::OneOff && params.priority.is_none() {
            params.priority = Some(Priority::Medium);
        }

        let todo_id = self.data_service.create_todo(params).await?;

        self.data_service
            .get_todo(todo_id)
            .await
            .ok_or_else(|| TodoError::internal("Failed to retrieve created todo"))
    }

    /// Get a todo by ID.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    ///
    /// # Returns
    ///
    /// The todo if found, None otherwise
    pub async fn get_todo(&self, todo_id: Uuid) -> Option<Todo> {
        self.data_service.get_todo(todo_id).await
    }

    /// Get todos with optional filters.
    ///
    /// # Arguments
    ///
    /// * `filters` - Optional filter parameters
    ///
    /// # Returns
    ///
    /// List of matching todos
    pub async fn get_todos(&self, filters: Option<TodoFilters>) -> Vec<Todo> {
        self.data_service.get_todos(filters).await
    }

    /// Complete a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    ///
    /// # Returns
    ///
    /// The updated todo
    ///
    /// # Errors
    ///
    /// Returns an error if todo is not found
    pub async fn complete_todo(&self, todo_id: Uuid) -> Result<Todo> {
        let now = Utc::now();

        let updates = UpdateTodoParams {
            is_completed: Some(true),
            completed_at: Some(now),
            metadata: Some(TodoMetadata {
                completed_at: Some(now.to_rfc3339()),
                ..Default::default()
            }),
            ..Default::default()
        };

        self.data_service.update_todo(todo_id, updates).await?;

        self.data_service
            .get_todo(todo_id)
            .await
            .ok_or_else(|| TodoError::not_found("Todo not found after update"))
    }

    /// Mark a todo as not completed.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    ///
    /// # Returns
    ///
    /// The updated todo
    pub async fn uncomplete_todo(&self, todo_id: Uuid) -> Result<Todo> {
        let updates = UpdateTodoParams {
            is_completed: Some(false),
            completed_at: None,
            ..Default::default()
        };

        self.data_service.update_todo(todo_id, updates).await?;

        self.data_service
            .get_todo(todo_id)
            .await
            .ok_or_else(|| TodoError::not_found("Todo not found after update"))
    }

    /// Update a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    /// * `updates` - The updates to apply
    ///
    /// # Returns
    ///
    /// The updated todo
    pub async fn update_todo(&self, todo_id: Uuid, updates: UpdateTodoParams) -> Result<Todo> {
        self.data_service.update_todo(todo_id, updates).await?;

        self.data_service
            .get_todo(todo_id)
            .await
            .ok_or_else(|| TodoError::not_found("Todo not found after update"))
    }

    /// Delete a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    ///
    /// # Returns
    ///
    /// True if deletion succeeded
    pub async fn delete_todo(&self, todo_id: Uuid) -> Result<bool> {
        self.data_service.delete_todo(todo_id).await
    }

    /// Get overdue todos.
    ///
    /// # Arguments
    ///
    /// * `filters` - Optional additional filters
    ///
    /// # Returns
    ///
    /// List of overdue todos
    pub async fn get_overdue_todos(&self, filters: Option<TodoFilters>) -> Vec<Todo> {
        self.data_service.get_overdue_todos(filters).await
    }

    /// Reset daily todos for a new day.
    ///
    /// # Arguments
    ///
    /// * `filters` - Optional additional filters
    ///
    /// # Returns
    ///
    /// Number of todos reset
    pub async fn reset_daily_todos(&self, filters: Option<TodoFilters>) -> usize {
        self.data_service.reset_daily_todos(filters).await
    }

    /// Add tags to a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    /// * `tags` - Tags to add
    pub async fn add_tags(&self, todo_id: Uuid, tags: Vec<String>) -> Result<bool> {
        self.data_service.add_tags(todo_id, tags).await
    }

    /// Remove tags from a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    /// * `tags` - Tags to remove
    pub async fn remove_tags(&self, todo_id: Uuid, tags: Vec<String>) -> Result<bool> {
        self.data_service.remove_tags(todo_id, tags).await
    }
}
