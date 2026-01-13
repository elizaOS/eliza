//! Agent hooks for monitoring and extending agent behavior

use crate::types::{AgentInfo, History, StepOutput, Trajectory};
use async_trait::async_trait;

/// Abstract hook for agent events
#[async_trait]
pub trait AgentHook: Send + Sync {
    /// Called when agent is initialized
    fn on_init(&mut self, _agent: &dyn std::any::Any) {}

    /// Called when tools installation starts
    fn on_tools_installation_started(&mut self) {}

    /// Called when setup attempt begins
    fn on_setup_attempt(&mut self) {}

    /// Called when setup is complete
    fn on_setup_done(&mut self) {}

    /// Called when a query message is added to history
    fn on_query_message_added(&mut self, _message: &QueryMessageEvent) {}

    /// Called when model is queried
    fn on_model_query(&mut self, _history: &History, _agent_name: &str) {}

    /// Called when actions are generated
    fn on_actions_generated(&mut self, _step: &StepOutput) {}

    /// Called when action execution starts
    fn on_action_started(&mut self, _step: &StepOutput) {}

    /// Called when action execution completes
    fn on_action_executed(&mut self, _step: &StepOutput) {}

    /// Called when a step starts
    fn on_step_start(&mut self) {}

    /// Called when a step completes
    fn on_step_done(&mut self, _step: &StepOutput, _info: &AgentInfo) {}

    /// Called when a run starts
    fn on_run_start(&mut self) {}

    /// Called when a run completes
    fn on_run_done(&mut self, _trajectory: &Trajectory, _info: &AgentInfo) {}
}

/// Event data for query message added
#[derive(Debug, Clone)]
pub struct QueryMessageEvent {
    pub agent: String,
    pub role: String,
    pub content: String,
    pub message_type: String,
    pub is_demo: Option<bool>,
    pub thought: Option<String>,
    pub action: Option<String>,
}

/// Combined hook that wraps multiple hooks
pub struct CombinedAgentHook {
    hooks: Vec<Box<dyn AgentHook>>,
}

impl CombinedAgentHook {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn add_hook(&mut self, hook: Box<dyn AgentHook>) {
        self.hooks.push(hook);
    }
}

impl Default for CombinedAgentHook {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentHook for CombinedAgentHook {
    fn on_init(&mut self, agent: &dyn std::any::Any) {
        for hook in &mut self.hooks {
            hook.on_init(agent);
        }
    }

    fn on_tools_installation_started(&mut self) {
        for hook in &mut self.hooks {
            hook.on_tools_installation_started();
        }
    }

    fn on_setup_attempt(&mut self) {
        for hook in &mut self.hooks {
            hook.on_setup_attempt();
        }
    }

    fn on_setup_done(&mut self) {
        for hook in &mut self.hooks {
            hook.on_setup_done();
        }
    }

    fn on_query_message_added(&mut self, message: &QueryMessageEvent) {
        for hook in &mut self.hooks {
            hook.on_query_message_added(message);
        }
    }

    fn on_model_query(&mut self, history: &History, agent_name: &str) {
        for hook in &mut self.hooks {
            hook.on_model_query(history, agent_name);
        }
    }

    fn on_actions_generated(&mut self, step: &StepOutput) {
        for hook in &mut self.hooks {
            hook.on_actions_generated(step);
        }
    }

    fn on_action_started(&mut self, step: &StepOutput) {
        for hook in &mut self.hooks {
            hook.on_action_started(step);
        }
    }

    fn on_action_executed(&mut self, step: &StepOutput) {
        for hook in &mut self.hooks {
            hook.on_action_executed(step);
        }
    }

    fn on_step_start(&mut self) {
        for hook in &mut self.hooks {
            hook.on_step_start();
        }
    }

    fn on_step_done(&mut self, step: &StepOutput, info: &AgentInfo) {
        for hook in &mut self.hooks {
            hook.on_step_done(step, info);
        }
    }

    fn on_run_start(&mut self) {
        for hook in &mut self.hooks {
            hook.on_run_start();
        }
    }

    fn on_run_done(&mut self, trajectory: &Trajectory, info: &AgentInfo) {
        for hook in &mut self.hooks {
            hook.on_run_done(trajectory, info);
        }
    }
}

/// Status hook that logs agent progress
pub struct StatusHook {
    pub show_progress: bool,
}

impl StatusHook {
    pub fn new(show_progress: bool) -> Self {
        Self { show_progress }
    }
}

impl Default for StatusHook {
    fn default() -> Self {
        Self::new(true)
    }
}

#[async_trait]
impl AgentHook for StatusHook {
    fn on_step_start(&mut self) {
        if self.show_progress {
            tracing::info!("Step started");
        }
    }

    fn on_step_done(&mut self, step: &StepOutput, _info: &AgentInfo) {
        if self.show_progress {
            tracing::info!(
                done = step.done,
                exit_status = ?step.exit_status,
                "Step completed"
            );
        }
    }

    fn on_run_done(&mut self, trajectory: &Trajectory, info: &AgentInfo) {
        if self.show_progress {
            tracing::info!(
                steps = trajectory.len(),
                submission = ?info.submission,
                exit_status = ?info.exit_status,
                "Run completed"
            );
        }
    }
}
