//! Run hooks for monitoring and extending run behavior

use crate::types::AgentRunResult;
use async_trait::async_trait;

/// Hook for run events
#[async_trait]
pub trait RunHook: Send + Sync {
    /// Called when run is initialized
    fn on_init(&mut self, _run: &dyn std::any::Any) {}

    /// Called when run starts
    fn on_start(&mut self) {}

    /// Called when run ends
    fn on_end(&mut self) {}

    /// Called when an instance is skipped
    fn on_instance_skipped(&mut self, _reason: &str) {}

    /// Called when an instance starts
    fn on_instance_start(&mut self, _index: usize, _instance_id: &str) {}

    /// Called when an instance completes
    fn on_instance_completed(&mut self, _result: &AgentRunResult) {}
}

/// Combined hook that wraps multiple hooks
pub struct CombinedRunHook {
    hooks: Vec<Box<dyn RunHook>>,
}

impl CombinedRunHook {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn add_hook(&mut self, hook: Box<dyn RunHook>) {
        self.hooks.push(hook);
    }
}

impl Default for CombinedRunHook {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RunHook for CombinedRunHook {
    fn on_init(&mut self, run: &dyn std::any::Any) {
        for hook in &mut self.hooks {
            hook.on_init(run);
        }
    }

    fn on_start(&mut self) {
        for hook in &mut self.hooks {
            hook.on_start();
        }
    }

    fn on_end(&mut self) {
        for hook in &mut self.hooks {
            hook.on_end();
        }
    }

    fn on_instance_skipped(&mut self, reason: &str) {
        for hook in &mut self.hooks {
            hook.on_instance_skipped(reason);
        }
    }

    fn on_instance_start(&mut self, index: usize, instance_id: &str) {
        for hook in &mut self.hooks {
            hook.on_instance_start(index, instance_id);
        }
    }

    fn on_instance_completed(&mut self, result: &AgentRunResult) {
        for hook in &mut self.hooks {
            hook.on_instance_completed(result);
        }
    }
}

/// Hook to save applied patches
pub struct SaveApplyPatchHook {
    pub output_dir: String,
}

impl SaveApplyPatchHook {
    pub fn new(output_dir: impl Into<String>) -> Self {
        Self {
            output_dir: output_dir.into(),
        }
    }
}

#[async_trait]
impl RunHook for SaveApplyPatchHook {
    fn on_instance_completed(&mut self, result: &AgentRunResult) {
        if let Some(ref _submission) = result.info.submission {
            let patch_path = std::path::Path::new(&self.output_dir).join("patches");
            let _ = std::fs::create_dir_all(&patch_path);

            // Save the patch
            // In a full implementation, would write to file based on instance ID
            tracing::info!(path = ?patch_path, "Would save patch");
        }
    }
}

/// Hook to open PRs
pub struct OpenPRHook {
    pub github_token: Option<String>,
}

impl OpenPRHook {
    pub fn new(github_token: Option<String>) -> Self {
        Self { github_token }
    }
}

#[async_trait]
impl RunHook for OpenPRHook {
    fn on_instance_completed(&mut self, result: &AgentRunResult) {
        if result.info.submission.is_some() && self.github_token.is_some() {
            // In a full implementation, would create a PR using GitHub API
            tracing::info!("Would create PR with submission");
        }
    }
}
