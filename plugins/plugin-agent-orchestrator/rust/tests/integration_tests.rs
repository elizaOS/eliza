//! Integration tests for the Agent Orchestrator plugin.

use elizaos_plugin_agent_orchestrator::{
    config::{
        configure_agent_orchestrator_plugin, reset_configuration, AgentOrchestratorPluginOptions,
    },
    error::Result,
    service::{AgentOrchestratorService, RoomInfo, Runtime},
    types::*,
};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// Mock task storage
struct MockTaskStorage {
    tasks: RwLock<HashMap<String, OrchestratedTask>>,
    counter: RwLock<u32>,
}

impl MockTaskStorage {
    fn new() -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            counter: RwLock::new(0),
        }
    }
}

/// Mock runtime for testing
struct MockRuntime {
    agent_id: String,
    storage: Arc<MockTaskStorage>,
}

impl MockRuntime {
    fn new() -> Self {
        Self {
            agent_id: "test-agent-id".to_string(),
            storage: Arc::new(MockTaskStorage::new()),
        }
    }
}

#[async_trait::async_trait]
impl Runtime for MockRuntime {
    fn agent_id(&self) -> &str {
        &self.agent_id
    }

    async fn create_task(&self, input: serde_json::Value) -> Result<String> {
        let mut counter = self.storage.counter.write().unwrap();
        *counter += 1;
        let task_id = format!("task-{}", *counter);

        let metadata: OrchestratedTaskMetadata =
            serde_json::from_value(input.get("metadata").cloned().unwrap_or_default())
                .unwrap_or_else(|_| OrchestratedTaskMetadata::new("default", "/tmp"));

        let task = OrchestratedTask {
            id: task_id.clone(),
            name: input
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            description: input
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            metadata,
            tags: input
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            room_id: input
                .get("roomId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            world_id: input
                .get("worldId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        };

        self.storage
            .tasks
            .write()
            .unwrap()
            .insert(task_id.clone(), task);
        Ok(task_id)
    }

    async fn get_task(&self, task_id: &str) -> Result<Option<OrchestratedTask>> {
        Ok(self.storage.tasks.read().unwrap().get(task_id).cloned())
    }

    async fn get_tasks(&self, tags: &[&str]) -> Result<Vec<OrchestratedTask>> {
        let tasks = self.storage.tasks.read().unwrap();
        Ok(tasks
            .values()
            .filter(|t| tags.is_empty() || tags.iter().any(|tag| t.tags.contains(&tag.to_string())))
            .cloned()
            .collect())
    }

    async fn update_task(&self, task_id: &str, updates: serde_json::Value) -> Result<()> {
        let mut tasks = self.storage.tasks.write().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            if let Some(metadata) = updates.get("metadata") {
                task.metadata =
                    serde_json::from_value(metadata.clone()).unwrap_or(task.metadata.clone());
            }
        }
        Ok(())
    }

    async fn delete_task(&self, task_id: &str) -> Result<()> {
        self.storage.tasks.write().unwrap().remove(task_id);
        Ok(())
    }

    async fn get_room(&self, _room_id: &str) -> Result<Option<RoomInfo>> {
        Ok(None)
    }
}

/// No-op provider for testing
struct NoOpProvider;

#[async_trait::async_trait]
impl AgentProvider for NoOpProvider {
    fn id(&self) -> &str {
        "noop"
    }

    fn label(&self) -> &str {
        "No-Op Provider"
    }

    async fn execute_task(
        &self,
        _task: &OrchestratedTask,
        ctx: &ProviderTaskExecutionContext,
    ) -> TaskResult {
        (ctx.append_output)("No-op execution".to_string());
        (ctx.update_progress)(100);
        TaskResult::success("No-op completed")
    }
}

fn setup() {
    reset_configuration();
    configure_agent_orchestrator_plugin(AgentOrchestratorPluginOptions::new(
        vec![Arc::new(NoOpProvider)],
        "noop",
        || "/tmp".to_string(),
    ));
}

#[tokio::test]
async fn test_create_task() {
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    let task = service
        .create_task("Test Task", "Test description", None, None)
        .await
        .unwrap();

    assert_eq!(task.name, "Test Task");
    assert_eq!(task.description, "Test description");
    assert_eq!(task.metadata.status, TaskStatus::Pending);
    assert_eq!(task.metadata.progress, 0);
    assert_eq!(task.metadata.provider_id, "noop");
}

#[tokio::test]
async fn test_get_recent_tasks() {
    reset_configuration();
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    service
        .create_task("Task 1", "Description 1", None, None)
        .await
        .unwrap();
    service
        .create_task("Task 2", "Description 2", None, None)
        .await
        .unwrap();
    service
        .create_task("Task 3", "Description 3", None, None)
        .await
        .unwrap();

    let tasks = service.get_recent_tasks(2).await.unwrap();
    assert_eq!(tasks.len(), 2);
    reset_configuration();
}

#[tokio::test]
async fn test_search_tasks() {
    reset_configuration();
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    service
        .create_task("Implement feature", "Feature description", None, None)
        .await
        .unwrap();
    service
        .create_task("Fix bug", "Bug description", None, None)
        .await
        .unwrap();

    let results = service.search_tasks("feature").await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "Implement feature");
    reset_configuration();
}

#[tokio::test]
async fn test_pause_resume_task() {
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    let task = service
        .create_task("Test Task", "Description", None, None)
        .await
        .unwrap();

    service.pause_task(&task.id).await.unwrap();
    let paused = service.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(paused.metadata.status, TaskStatus::Paused);

    service.resume_task(&task.id).await.unwrap();
    let resumed = service.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(resumed.metadata.status, TaskStatus::Running);
}

#[tokio::test]
async fn test_cancel_task() {
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    let task = service
        .create_task("Test Task", "Description", None, None)
        .await
        .unwrap();

    service.cancel_task(&task.id).await.unwrap();
    let cancelled = service.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(cancelled.metadata.status, TaskStatus::Cancelled);
}

#[tokio::test]
async fn test_update_progress() {
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    let task = service
        .create_task("Test Task", "Description", None, None)
        .await
        .unwrap();

    service.update_task_progress(&task.id, 50).await.unwrap();
    let updated = service.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(updated.metadata.progress, 50);
}

#[tokio::test]
async fn test_add_step() {
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    let task = service
        .create_task("Test Task", "Description", None, None)
        .await
        .unwrap();

    let step = service.add_step(&task.id, "Step 1").await.unwrap();
    assert_eq!(step.description, "Step 1");
    assert_eq!(step.status, TaskStatus::Pending);

    let updated = service.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(updated.metadata.steps.len(), 1);
}

#[tokio::test]
async fn test_get_task_context() {
    setup();
    let runtime = Arc::new(MockRuntime::new());
    let (service, _rx) = AgentOrchestratorService::start(runtime).await.unwrap();

    let context = service.get_task_context().await.unwrap();
    assert!(context.contains("No tasks"));

    service
        .create_task("Test Task", "Description", None, None)
        .await
        .unwrap();
    let context = service.get_task_context().await.unwrap();
    assert!(context.contains("Test Task"));
}
