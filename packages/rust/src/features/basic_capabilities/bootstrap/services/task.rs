//! Task service implementation with scheduling capabilities.
//!
//! This module provides parity with the TypeScript TaskService, including:
//! - Timer-based task checking (tick loop)
//! - Task workers with execute/validate callbacks
//! - Tag-based filtering ("queue", "repeat")
//! - Blocking mechanism to prevent overlapping executions
//! - Automatic deletion of non-repeating tasks after execution

use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::memory::Memory;
use crate::types::state::State;
use crate::types::task::{Task, TaskMetadata};

use super::{Service, ServiceType};

/// Interval in milliseconds to check for tasks (parity with TypeScript TICK_INTERVAL)
const TICK_INTERVAL_MS: u64 = 1000;

/// Task worker trait - defines the contract for executing tasks.
/// Parity with TypeScript's TaskWorker interface.
#[async_trait]
pub trait TaskWorker: Send + Sync {
    /// The unique name of the task type this worker handles
    fn name(&self) -> &str;

    /// Execute the task
    async fn execute(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        options: HashMap<String, serde_json::Value>,
        task: Task,
    ) -> PluginResult<()>;

    /// Optional validation function
    async fn validate(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        _message: Memory,
        _state: State,
    ) -> bool {
        true
    }
}

/// Boxed task worker for storage
pub type BoxedTaskWorker = Box<dyn TaskWorker>;

/// Service for managing and scheduling tasks.
/// Provides parity with TypeScript's TaskService.
pub struct TaskService {
    /// Registered task workers by name
    workers: Arc<RwLock<HashMap<String, BoxedTaskWorker>>>,
    /// In-memory task storage
    tasks: Arc<RwLock<HashMap<String, Task>>>,
    /// Set of task IDs currently executing (prevents overlapping runs)
    executing_tasks: Arc<RwLock<HashSet<String>>>,
    /// Runtime reference
    runtime: Arc<RwLock<Option<Arc<dyn IAgentRuntime>>>>,
    /// Stop flag for the timer loop
    stop_flag: Arc<AtomicBool>,
    /// Task handle for the timer loop
    #[cfg(feature = "native")]
    loop_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
}

impl TaskService {
    /// Create a new task service.
    pub fn new() -> Self {
        Self {
            workers: Arc::new(RwLock::new(HashMap::new())),
            tasks: Arc::new(RwLock::new(HashMap::new())),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime: Arc::new(RwLock::new(None)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            #[cfg(feature = "native")]
            loop_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Register a task worker
    pub async fn register_worker(&self, worker: BoxedTaskWorker) {
        let name = worker.name().to_string();
        let mut workers = self.workers.write().await;
        workers.insert(name.clone(), worker);

        if let Some(runtime) = self.runtime.read().await.as_ref() {
            runtime.log_debug("service:task", &format!("Registered task worker: {}", name));
        }
    }

    /// Get a task worker by name
    pub async fn get_worker(&self, name: &str) -> Option<Arc<dyn TaskWorker>> {
        // Note: This returns a reference, but for async we need to handle ownership carefully
        // For simplicity, we check if worker exists
        self.workers
            .read()
            .await
            .contains_key(name)
            .then_some(())
            .and_then(|_| None)
    }

    /// Check if a worker exists for the given task name
    pub async fn has_worker(&self, name: &str) -> bool {
        self.workers.read().await.contains_key(name)
    }

    /// Validate an array of tasks.
    /// Skips tasks without IDs or if no worker is found.
    /// If a worker has a validate function, it will run validation.
    /// Parity with TypeScript's validateTasks.
    async fn validate_tasks(&self, tasks: Vec<Task>) -> Vec<Task> {
        let workers_guard = self.workers.read().await;
        let runtime = self.runtime.read().await;

        let rt = match runtime.as_ref() {
            Some(r) => Arc::clone(r),
            None => return vec![],
        };

        let mut validated_tasks = Vec::new();

        for task in tasks {
            // Skip tasks without IDs
            if task.id.is_none() {
                continue;
            }

            // Skip if no worker found for task
            let worker = match workers_guard.get(&task.name) {
                Some(w) => w,
                None => continue,
            };

            // If worker has validate function, run validation (pass empty message and state)
            let is_valid = worker
                .validate(Arc::clone(&rt), Memory::default(), State::default())
                .await;

            if !is_valid {
                continue;
            }

            validated_tasks.push(task);
        }

        validated_tasks
    }

    /// Create a new task
    pub async fn create_task(&self, mut task: Task) -> Task {
        let now = current_timestamp();

        // Ensure task has an ID
        if task.id.is_none() {
            task.id = Some(crate::types::primitives::UUID::new_v4());
        }

        // Set timestamps
        task.created_at = Some(now);
        task.updated_at = Some(now);

        // Ensure metadata exists with timestamps
        let mut metadata = task.metadata.take().unwrap_or_default();
        if metadata.updated_at.is_none() {
            metadata.updated_at = Some(now);
        }
        if metadata.created_at.is_none() {
            metadata.created_at = Some(now.to_string());
        }
        task.metadata = Some(metadata);

        let task_id = task.id.clone().unwrap().to_string();

        if let Some(runtime) = self.runtime.read().await.as_ref() {
            runtime.log_debug("service:task", &format!("Task created: {}", task_id));
        }

        self.tasks.write().await.insert(task_id, task.clone());
        task
    }

    /// Get a task by ID
    pub async fn get_task(&self, task_id: &str) -> Option<Task> {
        self.tasks.read().await.get(task_id).cloned()
    }

    /// Get tasks by name
    pub async fn get_tasks_by_name(&self, name: &str) -> Vec<Task> {
        self.tasks
            .read()
            .await
            .values()
            .filter(|t| t.name == name)
            .cloned()
            .collect()
    }

    /// Get tasks with specific tags
    pub async fn get_tasks_by_tags(&self, tags: &[String]) -> Vec<Task> {
        self.tasks
            .read()
            .await
            .values()
            .filter(|t| {
                if let Some(task_tags) = &t.tags {
                    tags.iter().all(|tag| task_tags.contains(tag))
                } else {
                    false
                }
            })
            .cloned()
            .collect()
    }

    /// Update a task
    pub async fn update_task(&self, task_id: &str, updates: TaskUpdateParams) -> Option<Task> {
        let mut tasks = self.tasks.write().await;
        if let Some(task) = tasks.get_mut(task_id) {
            task.updated_at = Some(current_timestamp());

            if let Some(metadata) = updates.metadata {
                let mut existing = task.metadata.take().unwrap_or_default();
                if let Some(updated_at) = metadata.updated_at {
                    existing.updated_at = Some(updated_at);
                }
                if let Some(interval) = metadata.update_interval {
                    existing.update_interval = Some(interval);
                }
                if let Some(blocking) = metadata.blocking {
                    existing.blocking = Some(blocking);
                }
                // Merge values if present
                if let Some(new_values) = metadata.values {
                    let mut values = existing.values.unwrap_or_default();
                    values.extend(new_values);
                    existing.values = Some(values);
                }
                task.metadata = Some(existing);
            }

            if let Some(tags) = updates.tags {
                task.tags = Some(tags);
            }

            if let Some(runtime) = self.runtime.read().await.as_ref() {
                runtime.log_debug("service:task", &format!("Task updated: {}", task_id));
            }

            Some(task.clone())
        } else {
            None
        }
    }

    /// Delete a task
    pub async fn delete_task(&self, task_id: &str) -> bool {
        let removed = self.tasks.write().await.remove(task_id).is_some();
        if removed {
            // Also remove from executing tasks if present
            self.executing_tasks.write().await.remove(task_id);

            if let Some(runtime) = self.runtime.read().await.as_ref() {
                runtime.log_debug("service:task", &format!("Task deleted: {}", task_id));
            }
        }
        removed
    }

    /// Start the timer loop for checking tasks
    #[cfg(feature = "native")]
    async fn start_timer(&self) {
        use tokio::time::{interval, Duration};

        let workers = Arc::clone(&self.workers);
        let tasks = Arc::clone(&self.tasks);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let runtime = Arc::clone(&self.runtime);
        let stop_flag = Arc::clone(&self.stop_flag);

        let handle = tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(TICK_INTERVAL_MS));

            while !stop_flag.load(Ordering::SeqCst) {
                ticker.tick().await;

                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }

                // Check and execute tasks
                if let Err(e) =
                    Self::check_tasks_inner(&workers, &tasks, &executing_tasks, &runtime).await
                {
                    warn!(error = %e, "Error checking tasks");
                }
            }

            info!("Task service timer loop stopped");
        });

        *self.loop_handle.write().await = Some(handle);
        info!("Task service timer loop started");
    }

    /// Check tasks and execute those that are due (inner implementation)
    async fn check_tasks_inner(
        workers: &Arc<RwLock<HashMap<String, BoxedTaskWorker>>>,
        tasks: &Arc<RwLock<HashMap<String, Task>>>,
        executing_tasks: &Arc<RwLock<HashSet<String>>>,
        runtime: &Arc<RwLock<Option<Arc<dyn IAgentRuntime>>>>,
    ) -> PluginResult<()> {
        let now = current_timestamp();

        // Get all tasks with "queue" tag
        let queue_tasks: Vec<Task> = {
            let tasks_guard = tasks.read().await;
            tasks_guard
                .values()
                .filter(|t| {
                    t.tags
                        .as_ref()
                        .map(|tags| tags.contains(&"queue".to_string()))
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        };

        let workers_guard = workers.read().await;
        let rt = match runtime.read().await.as_ref() {
            Some(r) => Arc::clone(r),
            None => return Ok(()),
        };

        // Validate tasks - parity with TypeScript validateTasks
        let mut validated_tasks = Vec::new();
        for task in queue_tasks {
            // Skip tasks without IDs
            if task.id.is_none() {
                continue;
            }

            // Skip if no worker found for task
            let worker = match workers_guard.get(&task.name) {
                Some(w) => w,
                None => continue,
            };

            // If worker has validate function, run validation (parity with TypeScript)
            let is_valid = worker
                .validate(Arc::clone(&rt), Memory::default(), State::default())
                .await;

            if !is_valid {
                continue;
            }

            validated_tasks.push(task);
        }

        for task in validated_tasks {
            let task_id = task.id.as_ref().unwrap().to_string();

            // Get worker again (we validated it exists)
            let worker = match workers_guard.get(&task.name) {
                Some(w) => w,
                None => continue,
            };

            // For non-repeating tasks, execute immediately
            if !task.is_repeating() {
                Self::execute_task_inner(&task, &task_id, worker, tasks, executing_tasks, runtime)
                    .await?;
                continue;
            }

            // For repeating tasks, check if interval has elapsed
            let task_start_time = task
                .updated_at
                .or_else(|| task.metadata.as_ref().and_then(|m| m.updated_at))
                .unwrap_or(0);

            let update_interval = task.get_update_interval().unwrap_or(0);

            // Check for immediate execution on first run
            let metadata_updated_at = task.metadata.as_ref().and_then(|m| m.updated_at);
            let metadata_created_at = task
                .metadata
                .as_ref()
                .and_then(|m| m.created_at.as_ref())
                .and_then(|s| s.parse::<i64>().ok());

            if metadata_updated_at == metadata_created_at {
                if task
                    .tags
                    .as_ref()
                    .map(|t| t.contains(&"immediate".to_string()))
                    .unwrap_or(false)
                {
                    debug!(task_name = %task.name, "Immediately running task");
                    Self::execute_task_inner(
                        &task,
                        &task_id,
                        worker,
                        tasks,
                        executing_tasks,
                        runtime,
                    )
                    .await?;
                    continue;
                }
            }

            // Check if enough time has passed
            if now - task_start_time >= update_interval {
                // Check blocking
                let is_blocking = task.is_blocking();
                if is_blocking && executing_tasks.read().await.contains(&task_id) {
                    debug!(
                        task_name = %task.name,
                        task_id = %task_id,
                        "Skipping task - already executing (blocking enabled)"
                    );
                    continue;
                }

                debug!(
                    task_name = %task.name,
                    interval_ms = %update_interval,
                    "Executing task - interval elapsed"
                );

                Self::execute_task_inner(&task, &task_id, worker, tasks, executing_tasks, runtime)
                    .await?;
            }
        }

        Ok(())
    }

    /// Execute a single task
    async fn execute_task_inner(
        task: &Task,
        task_id: &str,
        worker: &BoxedTaskWorker,
        tasks: &Arc<RwLock<HashMap<String, Task>>>,
        executing_tasks: &Arc<RwLock<HashSet<String>>>,
        runtime: &Arc<RwLock<Option<Arc<dyn IAgentRuntime>>>>,
    ) -> PluginResult<()> {
        let rt = match runtime.read().await.as_ref() {
            Some(r) => Arc::clone(r),
            None => return Ok(()),
        };

        // Mark task as executing
        executing_tasks.write().await.insert(task_id.to_string());
        let start_time = current_timestamp();

        // For repeating tasks, update the timestamp before execution
        if task.is_repeating() {
            let mut tasks_guard = tasks.write().await;
            if let Some(t) = tasks_guard.get_mut(task_id) {
                t.updated_at = Some(current_timestamp());
                if let Some(ref mut metadata) = t.metadata {
                    metadata.updated_at = Some(current_timestamp());
                }
            }
            drop(tasks_guard);
            debug!(task_name = %task.name, task_id = %task_id, "Updated repeating task timestamp");
        }

        // Execute the task
        let options = task
            .metadata
            .as_ref()
            .and_then(|m| m.values.clone())
            .unwrap_or_default();

        debug!(task_name = %task.name, task_id = %task_id, "Executing task");

        let result = worker.execute(rt.clone(), options, task.clone()).await;

        // For non-repeating tasks, delete after execution
        if !task.is_repeating() {
            tasks.write().await.remove(task_id);
            debug!(task_name = %task.name, task_id = %task_id, "Deleted non-repeating task after execution");
        }

        // Always remove from executing set
        executing_tasks.write().await.remove(task_id);

        let duration_ms = current_timestamp() - start_time;
        debug!(
            task_name = %task.name,
            task_id = %task_id,
            duration_ms = %duration_ms,
            "Task execution completed"
        );

        result
    }
}

impl Default for TaskService {
    fn default() -> Self {
        Self::new()
    }
}

/// Parameters for updating a task
#[derive(Clone, Debug, Default)]
pub struct TaskUpdateParams {
    pub metadata: Option<TaskMetadata>,
    pub tags: Option<Vec<String>>,
}

fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[async_trait]
impl Service for TaskService {
    fn name(&self) -> &'static str {
        "task"
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("service:task", "Task service started");
        *self.runtime.write().await = Some(runtime);
        self.stop_flag.store(false, Ordering::SeqCst);

        #[cfg(feature = "native")]
        self.start_timer().await;

        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        self.stop_flag.store(true, Ordering::SeqCst);

        #[cfg(feature = "native")]
        {
            if let Some(handle) = self.loop_handle.write().await.take() {
                handle.abort();
            }
        }

        if let Some(runtime) = self.runtime.read().await.as_ref() {
            runtime.log_info("service:task", "Task service stopped");
        }

        self.tasks.write().await.clear();
        self.executing_tasks.write().await.clear();
        *self.runtime.write().await = None;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_task_creation() {
        let service = TaskService::new();
        let task = Task::new("test-task");
        let created = service.create_task(task).await;

        assert_eq!(created.name, "test-task");
        assert!(created.id.is_some());
    }

    #[tokio::test]
    async fn test_get_tasks_by_tags() {
        let service = TaskService::new();

        let mut task1 = Task::new("task1");
        task1.tags = Some(vec!["queue".to_string(), "repeat".to_string()]);
        service.create_task(task1).await;

        let mut task2 = Task::new("task2");
        task2.tags = Some(vec!["queue".to_string()]);
        service.create_task(task2).await;

        let mut task3 = Task::new("task3");
        task3.tags = Some(vec!["other".to_string()]);
        service.create_task(task3).await;

        let queue_tasks = service.get_tasks_by_tags(&["queue".to_string()]).await;
        assert_eq!(queue_tasks.len(), 2);

        let repeat_tasks = service
            .get_tasks_by_tags(&["queue".to_string(), "repeat".to_string()])
            .await;
        assert_eq!(repeat_tasks.len(), 1);
    }

    #[tokio::test]
    async fn test_delete_task() {
        let service = TaskService::new();
        let task = Task::new("test-task");
        let created = service.create_task(task).await;
        let task_id = created.id.unwrap().to_string();

        assert!(service.get_task(&task_id).await.is_some());
        assert!(service.delete_task(&task_id).await);
        assert!(service.get_task(&task_id).await.is_none());
    }

    #[tokio::test]
    async fn test_update_task() {
        let service = TaskService::new();
        let task = Task::repeating("test-task", 30000);
        let created = service.create_task(task).await;
        let task_id = created.id.unwrap().to_string();

        let updates = TaskUpdateParams {
            metadata: Some(TaskMetadata {
                update_interval: Some(60000),
                ..Default::default()
            }),
            tags: None,
        };

        let updated = service.update_task(&task_id, updates).await;
        assert!(updated.is_some());
        let updated = updated.unwrap();
        assert_eq!(updated.get_update_interval(), Some(60000));
    }
}
