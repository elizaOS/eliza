#![allow(missing_docs)]
//! Data service for Todo operations.

use crate::error::{Result, TodoError};
use crate::types::{
    CreateTodoParams, Priority, TaskType, Todo, TodoFilters, TodoMetadata, UpdateTodoParams,
};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Manages todo data and database operations.
///
/// This service provides CRUD operations for todos with support for
/// filtering, tags, and metadata management.
pub struct TodoDataService {
    todos: Arc<RwLock<HashMap<Uuid, Todo>>>,
    tags: Arc<RwLock<HashMap<Uuid, Vec<String>>>>,
}

impl Default for TodoDataService {
    fn default() -> Self {
        Self::new()
    }
}

impl TodoDataService {
    /// Create a new data service instance.
    pub fn new() -> Self {
        Self {
            todos: Arc::new(RwLock::new(HashMap::new())),
            tags: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create a new todo.
    ///
    /// # Arguments
    ///
    /// * `params` - Parameters for creating the todo
    ///
    /// # Returns
    ///
    /// UUID of the created todo
    ///
    /// # Errors
    ///
    /// Returns an error if parameters are invalid
    pub async fn create_todo(&self, params: CreateTodoParams) -> Result<Uuid> {
        if params.name.trim().is_empty() {
            return Err(TodoError::validation("Todo name is required"));
        }

        let now = Utc::now();
        let todo_id = Uuid::new_v4();

        let mut metadata = params.metadata.unwrap_or_default();
        metadata.created_at = Some(now.to_rfc3339());

        let priority = if params.task_type == TaskType::OneOff && params.priority.is_none() {
            Some(Priority::Medium)
        } else {
            params.priority
        };

        let todo = Todo {
            id: todo_id,
            agent_id: params.agent_id,
            world_id: params.world_id,
            room_id: params.room_id,
            entity_id: params.entity_id,
            name: params.name.trim().to_string(),
            description: params.description,
            task_type: params.task_type,
            priority,
            is_urgent: params.is_urgent,
            is_completed: false,
            due_date: params.due_date,
            completed_at: None,
            created_at: now,
            updated_at: now,
            metadata,
            tags: params.tags.clone(),
        };

        {
            let mut todos = self.todos.write().await;
            todos.insert(todo_id, todo);
        }

        {
            let mut tags = self.tags.write().await;
            tags.insert(todo_id, params.tags);
        }

        Ok(todo_id)
    }

    /// Get a single todo by ID.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    ///
    /// # Returns
    ///
    /// The todo if found, None otherwise
    pub async fn get_todo(&self, todo_id: Uuid) -> Option<Todo> {
        let todos = self.todos.read().await;
        let tags = self.tags.read().await;

        todos.get(&todo_id).map(|todo| {
            let mut todo = todo.clone();
            todo.tags = tags.get(&todo_id).cloned().unwrap_or_default();
            todo
        })
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
        let todos = self.todos.read().await;
        let tags_map = self.tags.read().await;

        let mut result: Vec<Todo> = todos
            .values()
            .filter(|todo| {
                if let Some(ref f) = filters {
                    if let Some(agent_id) = f.agent_id {
                        if todo.agent_id != agent_id {
                            return false;
                        }
                    }
                    if let Some(world_id) = f.world_id {
                        if todo.world_id != world_id {
                            return false;
                        }
                    }
                    if let Some(room_id) = f.room_id {
                        if todo.room_id != room_id {
                            return false;
                        }
                    }
                    if let Some(entity_id) = f.entity_id {
                        if todo.entity_id != entity_id {
                            return false;
                        }
                    }
                    if let Some(task_type) = f.task_type {
                        if todo.task_type != task_type {
                            return false;
                        }
                    }
                    if let Some(is_completed) = f.is_completed {
                        if todo.is_completed != is_completed {
                            return false;
                        }
                    }
                    if let Some(ref filter_tags) = f.tags {
                        let todo_tags = tags_map.get(&todo.id).cloned().unwrap_or_default();
                        if !filter_tags.iter().any(|t| todo_tags.contains(t)) {
                            return false;
                        }
                    }
                }
                true
            })
            .map(|todo| {
                let mut todo = todo.clone();
                todo.tags = tags_map.get(&todo.id).cloned().unwrap_or_default();
                todo
            })
            .collect();

        // Sort by created_at descending
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        // Apply limit
        if let Some(ref f) = filters {
            if let Some(limit) = f.limit {
                result.truncate(limit);
            }
        }

        result
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
    /// True if update succeeded
    ///
    /// # Errors
    ///
    /// Returns an error if todo is not found
    pub async fn update_todo(&self, todo_id: Uuid, updates: UpdateTodoParams) -> Result<bool> {
        let mut todos = self.todos.write().await;

        let todo = todos
            .get_mut(&todo_id)
            .ok_or_else(|| TodoError::not_found(format!("Todo {} not found", todo_id)))?;

        if let Some(name) = updates.name {
            todo.name = name;
        }
        if let Some(description) = updates.description {
            todo.description = Some(description);
        }
        if let Some(priority) = updates.priority {
            todo.priority = Some(priority);
        }
        if let Some(is_urgent) = updates.is_urgent {
            todo.is_urgent = is_urgent;
        }
        if let Some(is_completed) = updates.is_completed {
            todo.is_completed = is_completed;
        }
        if let Some(due_date) = updates.due_date {
            todo.due_date = Some(due_date);
        }
        if let Some(completed_at) = updates.completed_at {
            todo.completed_at = Some(completed_at);
        }
        if let Some(metadata) = updates.metadata {
            todo.metadata = metadata;
        }

        todo.updated_at = Utc::now();

        Ok(true)
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
    ///
    /// # Errors
    ///
    /// Returns an error if todo is not found
    pub async fn delete_todo(&self, todo_id: Uuid) -> Result<bool> {
        let mut todos = self.todos.write().await;
        let mut tags = self.tags.write().await;

        if todos.remove(&todo_id).is_none() {
            return Err(TodoError::not_found(format!("Todo {} not found", todo_id)));
        }

        tags.remove(&todo_id);

        Ok(true)
    }

    /// Add tags to a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    /// * `new_tags` - Tags to add
    ///
    /// # Returns
    ///
    /// True if operation succeeded
    pub async fn add_tags(&self, todo_id: Uuid, new_tags: Vec<String>) -> Result<bool> {
        let todos = self.todos.read().await;
        if !todos.contains_key(&todo_id) {
            return Err(TodoError::not_found(format!("Todo {} not found", todo_id)));
        }
        drop(todos);

        let mut tags = self.tags.write().await;
        let existing = tags.entry(todo_id).or_default();

        for tag in new_tags {
            if !existing.contains(&tag) {
                existing.push(tag);
            }
        }

        Ok(true)
    }

    /// Remove tags from a todo.
    ///
    /// # Arguments
    ///
    /// * `todo_id` - The todo's UUID
    /// * `tags_to_remove` - Tags to remove
    ///
    /// # Returns
    ///
    /// True if operation succeeded
    pub async fn remove_tags(&self, todo_id: Uuid, tags_to_remove: Vec<String>) -> Result<bool> {
        let todos = self.todos.read().await;
        if !todos.contains_key(&todo_id) {
            return Err(TodoError::not_found(format!("Todo {} not found", todo_id)));
        }
        drop(todos);

        let mut tags = self.tags.write().await;
        if let Some(existing) = tags.get_mut(&todo_id) {
            existing.retain(|t| !tags_to_remove.contains(t));
        }

        Ok(true)
    }

    /// Get overdue tasks.
    ///
    /// # Arguments
    ///
    /// * `filters` - Optional additional filters
    ///
    /// # Returns
    ///
    /// List of overdue todos
    pub async fn get_overdue_todos(&self, filters: Option<TodoFilters>) -> Vec<Todo> {
        let now = Utc::now();
        let todos = self.get_todos(filters).await;

        todos
            .into_iter()
            .filter(|t| !t.is_completed && t.due_date.map(|d| d < now).unwrap_or(false))
            .collect()
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
        let mut base_filters = TodoFilters {
            task_type: Some(TaskType::Daily),
            is_completed: Some(true),
            ..Default::default()
        };

        if let Some(f) = filters {
            base_filters.agent_id = f.agent_id;
            base_filters.world_id = f.world_id;
            base_filters.room_id = f.room_id;
            base_filters.entity_id = f.entity_id;
        }

        let todos_to_reset = self.get_todos(Some(base_filters)).await;
        let count = todos_to_reset.len();

        for todo in todos_to_reset {
            let updates = UpdateTodoParams {
                is_completed: Some(false),
                completed_at: None,
                metadata: Some(TodoMetadata {
                    completed_today: Some(false),
                    ..todo.metadata
                }),
                ..Default::default()
            };
            let _ = self.update_todo(todo.id, updates).await;
        }

        count
    }
}

/// Create a new TodoDataService instance.
pub fn create_todo_data_service() -> TodoDataService {
    TodoDataService::new()
}
