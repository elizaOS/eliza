//! Configuration management for the Agent Orchestrator plugin.

use crate::types::AgentProvider;
use std::sync::{Arc, RwLock};

/// Configuration options for the orchestrator plugin
pub struct AgentOrchestratorPluginOptions {
    /// Providers available to the orchestrator
    pub providers: Vec<Arc<dyn AgentProvider>>,

    /// Default provider id when user hasn't selected one
    pub default_provider_id: String,

    /// Function to supply a working directory string
    pub get_working_directory: Box<dyn Fn() -> String + Send + Sync>,

    /// Environment variable that controls which provider is active
    pub active_provider_env_var: String,
}

impl AgentOrchestratorPluginOptions {
    /// Create new options with defaults
    pub fn new(
        providers: Vec<Arc<dyn AgentProvider>>,
        default_provider_id: impl Into<String>,
        get_working_directory: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            providers,
            default_provider_id: default_provider_id.into(),
            get_working_directory: Box::new(get_working_directory),
            active_provider_env_var: "ELIZA_CODE_ACTIVE_SUB_AGENT".to_string(),
        }
    }

    /// Set the active provider environment variable name
    pub fn with_env_var(mut self, env_var: impl Into<String>) -> Self {
        self.active_provider_env_var = env_var.into();
        self
    }
}

// Global configuration storage
static CONFIGURED_OPTIONS: RwLock<Option<Arc<AgentOrchestratorPluginOptions>>> = RwLock::new(None);

/// Configure the agent orchestrator plugin with providers.
///
/// This must be called before the runtime is initialized.
pub fn configure_agent_orchestrator_plugin(options: AgentOrchestratorPluginOptions) {
    let mut global = CONFIGURED_OPTIONS.write().unwrap();
    *global = Some(Arc::new(options));
}

/// Get the configured options, or None if not configured.
pub fn get_configured_options() -> Option<Arc<AgentOrchestratorPluginOptions>> {
    CONFIGURED_OPTIONS.read().unwrap().clone()
}

/// Reset configuration (useful for testing)
pub fn reset_configuration() {
    let mut global = CONFIGURED_OPTIONS.write().unwrap();
    *global = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{OrchestratedTask, ProviderTaskExecutionContext, TaskResult};

    struct TestProvider;

    #[async_trait::async_trait]
    impl AgentProvider for TestProvider {
        fn id(&self) -> &str {
            "test"
        }

        fn label(&self) -> &str {
            "Test Provider"
        }

        async fn execute_task(
            &self,
            _task: &OrchestratedTask,
            _ctx: &ProviderTaskExecutionContext,
        ) -> TaskResult {
            TaskResult::success("Test completed")
        }
    }

    #[test]
    fn test_configure_and_get() {
        reset_configuration();

        assert!(get_configured_options().is_none());

        let options = AgentOrchestratorPluginOptions::new(
            vec![Arc::new(TestProvider)],
            "test",
            || "/tmp".to_string(),
        );

        configure_agent_orchestrator_plugin(options);

        let opts = get_configured_options().unwrap();
        assert_eq!(opts.default_provider_id, "test");
        assert_eq!(opts.providers.len(), 1);

        reset_configuration();
    }
}
