//! Agent Orchestrator Service - manages task lifecycle and delegates to providers.

use crate::config::get_configured_options;
use crate::error::{OrchestratorError, Result};
use crate::types::*;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;

type ControlStates = Arc<RwLock<HashMap<String, ControlState>>>;

/// Current time in milliseconds
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Clamp progress to 0-100
fn clamp_progress(n: i32) -> i32 {
    n.clamp(0, 100)
}

/// Per-task control state
#[derive(Debug, Clone, Default)]
struct ControlState {
    cancelled: bool,
    paused: bool,
}

/// Runtime trait for abstracting the ElizaOS runtime
#[async_trait::async_trait]
pub trait Runtime: Send + Sync {
    fn agent_id(&self) -> &str;
    async fn create_task(&self, input: serde_json::Value) -> Result<String>;
    async fn get_task(&self, task_id: &str) -> Result<Option<OrchestratedTask>>;
    async fn get_tasks(&self, tags: &[&str]) -> Result<Vec<OrchestratedTask>>;
    async fn update_task(&self, task_id: &str, metadata: serde_json::Value) -> Result<()>;
    async fn delete_task(&self, task_id: &str) -> Result<()>;
    async fn get_room(&self, room_id: &str) -> Result<Option<RoomInfo>>;
}

/// Room information
#[derive(Debug, Clone)]
pub struct RoomInfo {
    pub id: String,
    pub world_id: Option<String>,
}

/// Agent Orchestrator Service
///
/// Orchestrates tasks across registered agent providers.
pub struct AgentOrchestratorService<R: Runtime> {
    runtime: Arc<R>,
    current_task_id: RwLock<Option<String>>,
    control_states: ControlStates,
    event_tx: mpsc::UnboundedSender<TaskEvent>,
}

impl<R: Runtime> AgentOrchestratorService<R> {
    /// Service type identifier
    pub const SERVICE_TYPE: &'static str = "CODE_TASK";

    /// Capability description
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Orchestrates tasks across registered agent providers";

    /// Create a new service instance
    pub fn new(runtime: Arc<R>) -> (Self, mpsc::UnboundedReceiver<TaskEvent>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        (
            Self {
                runtime,
                current_task_id: RwLock::new(None),
                control_states: Arc::new(RwLock::new(HashMap::new())),
                event_tx,
            },
            event_rx,
        )
    }

    /// Start the service
    pub async fn start(runtime: Arc<R>) -> Result<(Self, mpsc::UnboundedReceiver<TaskEvent>)> {
        Ok(Self::new(runtime))
    }

    // ========================================================================
    // Provider resolution
    // ========================================================================

    fn get_options(&self) -> Result<Arc<crate::config::AgentOrchestratorPluginOptions>> {
        get_configured_options().ok_or(OrchestratorError::NotConfigured)
    }

    fn get_active_provider_id(&self) -> Result<String> {
        let opts = self.get_options()?;
        let raw = std::env::var(&opts.active_provider_env_var).unwrap_or_default();
        let trimmed = raw.trim();
        Ok(if trimmed.is_empty() {
            opts.default_provider_id.clone()
        } else {
            trimmed.to_string()
        })
    }

    fn get_provider_by_id(&self, id: &str) -> Result<Option<Arc<dyn AgentProvider>>> {
        let opts = self.get_options()?;
        Ok(opts.providers.iter().find(|p| p.id() == id).cloned())
    }

    // ========================================================================
    // Current task
    // ========================================================================

    /// Get the current task ID
    pub fn get_current_task_id(&self) -> Option<String> {
        self.current_task_id.read().unwrap().clone()
    }

    /// Set the current task
    pub fn set_current_task(&self, task_id: Option<String>) {
        let mut current = self.current_task_id.write().unwrap();
        *current = task_id.clone();
        if let Some(id) = task_id {
            self.emit(TaskEventType::Progress, &id, Some(HashMap::from([
                ("selected".to_string(), serde_json::json!(true)),
            ])));
        }
    }

    /// Get the current task
    pub async fn get_current_task(&self) -> Result<Option<OrchestratedTask>> {
        match self.get_current_task_id() {
            Some(id) => self.get_task(&id).await,
            None => Ok(None),
        }
    }

    // ========================================================================
    // CRUD
    // ========================================================================

    /// Create a new orchestrated task
    pub async fn create_task(
        &self,
        name: &str,
        description: &str,
        room_id: Option<&str>,
        provider_id: Option<&str>,
    ) -> Result<OrchestratedTask> {
        let opts = self.get_options()?;
        let chosen_provider_id = provider_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.get_active_provider_id().unwrap_or_default());

        let provider = self
            .get_provider_by_id(&chosen_provider_id)?
            .ok_or_else(|| {
                let available = opts
                    .providers
                    .iter()
                    .map(|p| p.id())
                    .collect::<Vec<_>>()
                    .join(", ");
                OrchestratorError::UnknownProvider(chosen_provider_id.clone(), available)
            })?;

        let world_id = self.resolve_world_id(room_id).await?;
        let working_directory = (opts.get_working_directory)();

        let mut metadata = OrchestratedTaskMetadata::new(&chosen_provider_id, &working_directory);
        metadata.provider_label = Some(provider.label().to_string());
        metadata.sub_agent_type = Some(chosen_provider_id.clone());

        let task_input = serde_json::json!({
            "name": name,
            "description": description,
            "worldId": world_id,
            "tags": ["code", "queue", "orchestrator", "task"],
            "metadata": metadata,
            "roomId": room_id,
        });

        let task_id = self.runtime.create_task(task_input).await?;
        let task = self
            .runtime
            .get_task(&task_id)
            .await?
            .ok_or_else(|| OrchestratorError::RuntimeError("Failed to create task".to_string()))?;

        if self.get_current_task_id().is_none() {
            self.set_current_task(Some(task_id.clone()));
        }

        self.emit(TaskEventType::Created, &task_id, Some(HashMap::from([
            ("name".to_string(), serde_json::json!(task.name)),
            ("providerId".to_string(), serde_json::json!(provider.id())),
        ])));

        Ok(task)
    }

    async fn resolve_world_id(&self, room_id: Option<&str>) -> Result<String> {
        if let Some(rid) = room_id {
            if let Some(room) = self.runtime.get_room(rid).await? {
                if let Some(world_id) = room.world_id {
                    return Ok(world_id);
                }
            }
        }
        Ok(self.runtime.agent_id().to_string())
    }

    /// Get a task by ID
    pub async fn get_task(&self, task_id: &str) -> Result<Option<OrchestratedTask>> {
        self.runtime.get_task(task_id).await
    }

    /// Get all orchestrated tasks
    pub async fn get_tasks(&self) -> Result<Vec<OrchestratedTask>> {
        self.runtime.get_tasks(&["orchestrator"]).await
    }

    /// Get recent tasks sorted by creation time
    pub async fn get_recent_tasks(&self, limit: usize) -> Result<Vec<OrchestratedTask>> {
        let mut tasks = self.get_tasks().await?;
        tasks.sort_by(|a, b| b.metadata.created_at.cmp(&a.metadata.created_at));
        tasks.truncate(limit);
        Ok(tasks)
    }

    /// Get tasks by status
    pub async fn get_tasks_by_status(&self, status: TaskStatus) -> Result<Vec<OrchestratedTask>> {
        let tasks = self.get_tasks().await?;
        Ok(tasks
            .into_iter()
            .filter(|t| t.metadata.status == status)
            .collect())
    }

    /// Search tasks by query
    pub async fn search_tasks(&self, query: &str) -> Result<Vec<OrchestratedTask>> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(Vec::new());
        }

        let tasks = self.get_tasks().await?;
        Ok(tasks
            .into_iter()
            .filter(|t| {
                t.id.to_lowercase().starts_with(&q)
                    || t.name.to_lowercase().contains(&q)
                    || t.description.to_lowercase().contains(&q)
                    || t.tags.iter().any(|tag| tag.to_lowercase().contains(&q))
            })
            .collect())
    }

    // ========================================================================
    // Updates
    // ========================================================================

    /// Update task status
    pub async fn update_task_status(&self, task_id: &str, status: TaskStatus) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        metadata.status = status;

        if status == TaskStatus::Running && metadata.started_at.is_none() {
            metadata.started_at = Some(now());
        }
        if matches!(
            status,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        ) {
            metadata.completed_at = Some(now());
        }

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        let event_type = match status {
            TaskStatus::Running => TaskEventType::Started,
            TaskStatus::Completed => TaskEventType::Completed,
            TaskStatus::Failed => TaskEventType::Failed,
            TaskStatus::Paused => TaskEventType::Paused,
            TaskStatus::Cancelled => TaskEventType::Cancelled,
            _ => TaskEventType::Progress,
        };
        self.emit(event_type, task_id, Some(HashMap::from([
            ("status".to_string(), serde_json::json!(status.to_string())),
        ])));

        Ok(())
    }

    /// Update task progress
    pub async fn update_task_progress(&self, task_id: &str, progress: i32) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        metadata.progress = clamp_progress(progress);

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        self.emit(TaskEventType::Progress, task_id, Some(HashMap::from([
            ("progress".to_string(), serde_json::json!(metadata.progress)),
        ])));

        Ok(())
    }

    /// Append output to task
    pub async fn append_output(&self, task_id: &str, output: &str) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let lines: Vec<String> = output
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|s| s.to_string())
            .collect();

        let mut metadata = task.metadata;
        metadata.output.extend(lines.clone());
        if metadata.output.len() > 500 {
            metadata.output = metadata.output.split_off(metadata.output.len() - 500);
        }

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        self.emit(TaskEventType::Output, task_id, Some(HashMap::from([
            ("output".to_string(), serde_json::json!(lines)),
        ])));

        Ok(())
    }

    /// Add a step to a task
    pub async fn add_step(&self, task_id: &str, description: &str) -> Result<TaskStep> {
        let task = self
            .get_task(task_id)
            .await?
            .ok_or_else(|| OrchestratorError::TaskNotFound(task_id.to_string()))?;

        let step = TaskStep::new(description);
        let mut metadata = task.metadata;
        metadata.steps.push(step.clone());

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        Ok(step)
    }

    /// Update a step's status
    pub async fn update_step(
        &self,
        task_id: &str,
        step_id: &str,
        status: TaskStatus,
        output: Option<&str>,
    ) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        if let Some(step) = metadata.steps.iter_mut().find(|s| s.id == step_id) {
            step.status = status;
            if let Some(out) = output {
                step.output = Some(out.to_string());
            }
        }

        let total = metadata.steps.len();
        if total > 0 {
            let completed = metadata
                .steps
                .iter()
                .filter(|s| s.status == TaskStatus::Completed)
                .count();
            metadata.progress = clamp_progress(((completed * 100) / total) as i32);
        }

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        self.emit(TaskEventType::Progress, task_id, Some(HashMap::from([
            ("progress".to_string(), serde_json::json!(metadata.progress)),
        ])));

        Ok(())
    }

    /// Set the task result
    pub async fn set_task_result(&self, task_id: &str, result: TaskResult) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        metadata.files_created = result.files_created.clone();
        metadata.files_modified = result.files_modified.clone();

        if metadata.status != TaskStatus::Cancelled {
            metadata.status = if result.success {
                TaskStatus::Completed
            } else {
                TaskStatus::Failed
            };
            metadata.completed_at = Some(now());
        }

        if !result.success {
            if let Some(ref error) = result.error {
                metadata.error = Some(error.clone());
            }
        }

        metadata.result = Some(result.clone());

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        let event_type = if result.success {
            TaskEventType::Completed
        } else {
            TaskEventType::Failed
        };
        self.emit(event_type, task_id, Some(HashMap::from([
            ("success".to_string(), serde_json::json!(result.success)),
            ("summary".to_string(), serde_json::json!(result.summary)),
            ("error".to_string(), serde_json::json!(result.error)),
        ])));

        Ok(())
    }

    /// Set task error
    pub async fn set_task_error(&self, task_id: &str, error: &str) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        metadata.error = Some(error.to_string());

        if metadata.status != TaskStatus::Cancelled {
            metadata.status = TaskStatus::Failed;
            metadata.completed_at = Some(now());
        }

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        let event_type = if metadata.status == TaskStatus::Cancelled {
            TaskEventType::Cancelled
        } else {
            TaskEventType::Failed
        };
        self.emit(event_type, task_id, Some(HashMap::from([
            ("error".to_string(), serde_json::json!(error)),
        ])));

        Ok(())
    }

    /// Set user-controlled status
    pub async fn set_user_status(&self, task_id: &str, user_status: TaskUserStatus) -> Result<()> {
        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        metadata.user_status = user_status;
        metadata.user_status_updated_at = Some(now());

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        self.emit(TaskEventType::Progress, task_id, Some(HashMap::from([
            ("userStatus".to_string(), serde_json::json!(format!("{:?}", user_status).to_lowercase())),
        ])));

        Ok(())
    }

    // ========================================================================
    // Control
    // ========================================================================

    /// Pause a task
    pub async fn pause_task(&self, task_id: &str) -> Result<()> {
        self.set_control(task_id, Some(true), None);
        self.update_task_status(task_id, TaskStatus::Paused).await?;
        self.emit(TaskEventType::Paused, task_id, None);
        Ok(())
    }

    /// Resume a paused task
    pub async fn resume_task(&self, task_id: &str) -> Result<()> {
        self.set_control(task_id, Some(false), None);
        self.update_task_status(task_id, TaskStatus::Running).await?;
        self.emit(TaskEventType::Resumed, task_id, None);
        Ok(())
    }

    /// Cancel a task
    pub async fn cancel_task(&self, task_id: &str) -> Result<()> {
        self.set_control(task_id, None, Some(true));

        let task = match self.get_task(task_id).await? {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut metadata = task.metadata;
        metadata.status = TaskStatus::Cancelled;
        metadata.completed_at = Some(now());
        if metadata.error.is_none() {
            metadata.error = Some("Cancelled by user".to_string());
        }

        self.runtime
            .update_task(task_id, serde_json::json!({ "metadata": metadata }))
            .await?;

        self.emit(TaskEventType::Cancelled, task_id, Some(HashMap::from([
            ("status".to_string(), serde_json::json!("cancelled")),
        ])));

        Ok(())
    }

    /// Delete a task
    pub async fn delete_task(&self, task_id: &str) -> Result<()> {
        self.set_control(task_id, None, Some(true));
        self.runtime.delete_task(task_id).await?;

        if self.get_current_task_id().as_deref() == Some(task_id) {
            self.set_current_task(None);
        }

        self.emit(TaskEventType::Message, task_id, Some(HashMap::from([
            ("deleted".to_string(), serde_json::json!(true)),
        ])));

        Ok(())
    }

    /// Check if task is cancelled
    pub fn is_task_cancelled(&self, task_id: &str) -> bool {
        self.control_states
            .read()
            .unwrap()
            .get(task_id)
            .map(|s| s.cancelled)
            .unwrap_or(false)
    }

    /// Check if task is paused
    pub fn is_task_paused(&self, task_id: &str) -> bool {
        self.control_states
            .read()
            .unwrap()
            .get(task_id)
            .map(|s| s.paused)
            .unwrap_or(false)
    }

    fn set_control(&self, task_id: &str, paused: Option<bool>, cancelled: Option<bool>) {
        let mut states = self.control_states.write().unwrap();
        let state = states.entry(task_id.to_string()).or_default();
        if let Some(p) = paused {
            state.paused = p;
        }
        if let Some(c) = cancelled {
            state.cancelled = c;
        }
    }

    fn clear_control(&self, task_id: &str) {
        self.control_states.write().unwrap().remove(task_id);
    }

    // ========================================================================
    // Execution
    // ========================================================================

    /// Start task execution
    pub async fn start_task_execution(&self, task_id: &str) -> Result<()> {
        self.run_task_execution(task_id).await
    }

    async fn run_task_execution(&self, task_id: &str) -> Result<()> {
        let result: Result<()> = async {
            let task = self
                .get_task(task_id)
                .await?
                .ok_or_else(|| OrchestratorError::TaskNotFound(task_id.to_string()))?;

            self.clear_control(task_id);
            self.set_control(task_id, Some(false), Some(false));

            let provider = self
                .get_provider_by_id(&task.metadata.provider_id)?
                .ok_or_else(|| {
                    OrchestratorError::ProviderNotFound(task.metadata.provider_id.clone())
                })?;

            self.update_task_status(task_id, TaskStatus::Running).await?;
            self.append_output(
                task_id,
                &format!(
                    "Starting: {}\nProvider: {} ({})",
                    task.name,
                    provider.label(),
                    provider.id()
                ),
            )
            .await?;

            let task_id_clone = task_id.to_string();
            let states_for_cancelled = Arc::clone(&self.control_states);
            let states_for_paused = Arc::clone(&self.control_states);
            let id_for_cancelled = task_id_clone.clone();
            let id_for_paused = task_id_clone.clone();

            let ctx = ProviderTaskExecutionContext {
                runtime_agent_id: self.runtime.agent_id().to_string(),
                working_directory: task.metadata.working_directory.clone(),
                room_id: task.room_id.clone(),
                world_id: task.world_id.clone(),
                append_output: Box::new(move |_| {}),
                update_progress: Box::new(move |_| {}),
                update_step: Box::new(move |_, _, _| {}),
                is_cancelled: Box::new(move || {
                    states_for_cancelled
                        .read()
                        .unwrap()
                        .get(&id_for_cancelled)
                        .map(|s| s.cancelled)
                        .unwrap_or(false)
                }),
                is_paused: Box::new(move || {
                    states_for_paused
                        .read()
                        .unwrap()
                        .get(&id_for_paused)
                        .map(|s| s.paused)
                        .unwrap_or(false)
                }),
            };

            let result = provider.execute_task(&task, &ctx).await;
            self.set_task_result(task_id, result).await?;

            Ok(())
        }
        .await;

        if let Err(e) = result {
            self.set_task_error(task_id, &e.to_string()).await?;
        }

        self.clear_control(task_id);
        Ok(())
    }

    // ========================================================================
    // Events
    // ========================================================================

    fn emit(
        &self,
        event_type: TaskEventType,
        task_id: &str,
        data: Option<HashMap<String, JsonValue>>,
    ) {
        let event = TaskEvent {
            event_type,
            task_id: task_id.to_string(),
            data,
        };
        let _ = self.event_tx.send(event);
    }

    // ========================================================================
    // Context
    // ========================================================================

    /// Get task context for prompting
    pub async fn get_task_context(&self) -> Result<String> {
        let current = self.get_current_task().await?;
        let tasks = self.get_recent_tasks(10).await?;

        if tasks.is_empty() {
            return Ok("No tasks have been created yet.".to_string());
        }

        let mut lines: Vec<String> = Vec::new();
        let active = current.as_ref().or_else(|| tasks.first());

        if let Some(task) = active {
            let m = &task.metadata;
            lines.push(format!("## Current Task (selected): {}", task.name));
            lines.push(format!("- **Execution status**: {}", m.status));
            lines.push(format!("- **Progress**: {}%", m.progress));
            lines.push(format!(
                "- **Provider**: {}",
                m.provider_label.as_deref().unwrap_or(&m.provider_id)
            ));
            lines.push(String::new());

            if !task.description.is_empty() {
                lines.push("### Description".to_string());
                lines.push(task.description.clone());
                lines.push(String::new());
            }

            if !m.steps.is_empty() {
                lines.push("### Plan / Steps".to_string());
                for s in &m.steps {
                    lines.push(format!("- [{}] {}", s.status, s.description));
                }
                lines.push(String::new());
            }

            if !m.output.is_empty() {
                lines.push("### Task Output (history)".to_string());
                lines.push("```".to_string());
                let start = if m.output.len() > 200 {
                    m.output.len() - 200
                } else {
                    0
                };
                lines.extend(m.output[start..].iter().cloned());
                lines.push("```".to_string());
                lines.push(String::new());
            }
        }

        Ok(lines.join("\n").trim().to_string())
    }
}
