//! Environment hooks for monitoring and extending environment behavior

use async_trait::async_trait;

/// Abstract hook for environment events
#[async_trait]
pub trait EnvironmentHook: Send + Sync {
    /// Called when environment is initialized
    fn on_init(&mut self) {}

    /// Called when environment starts
    fn on_start(&mut self) {}

    /// Called when environment stops
    fn on_stop(&mut self) {}

    /// Called when a command is executed
    fn on_command_executed(&mut self, _command: &str, _output: &str) {}

    /// Called when environment is reset
    fn on_reset(&mut self) {}
}

/// Combined hook that wraps multiple hooks
pub struct CombinedEnvironmentHook {
    hooks: Vec<Box<dyn EnvironmentHook>>,
}

impl CombinedEnvironmentHook {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn add_hook(&mut self, hook: Box<dyn EnvironmentHook>) {
        self.hooks.push(hook);
    }
}

impl Default for CombinedEnvironmentHook {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl EnvironmentHook for CombinedEnvironmentHook {
    fn on_init(&mut self) {
        for hook in &mut self.hooks {
            hook.on_init();
        }
    }

    fn on_start(&mut self) {
        for hook in &mut self.hooks {
            hook.on_start();
        }
    }

    fn on_stop(&mut self) {
        for hook in &mut self.hooks {
            hook.on_stop();
        }
    }

    fn on_command_executed(&mut self, command: &str, output: &str) {
        for hook in &mut self.hooks {
            hook.on_command_executed(command, output);
        }
    }

    fn on_reset(&mut self) {
        for hook in &mut self.hooks {
            hook.on_reset();
        }
    }
}

/// Status hook for logging environment events
pub struct EnvironmentStatusHook {
    pub show_commands: bool,
}

impl EnvironmentStatusHook {
    pub fn new(show_commands: bool) -> Self {
        Self { show_commands }
    }
}

impl Default for EnvironmentStatusHook {
    fn default() -> Self {
        Self::new(false)
    }
}

#[async_trait]
impl EnvironmentHook for EnvironmentStatusHook {
    fn on_start(&mut self) {
        tracing::info!("Environment started");
    }

    fn on_stop(&mut self) {
        tracing::info!("Environment stopped");
    }

    fn on_command_executed(&mut self, command: &str, output: &str) {
        if self.show_commands {
            tracing::debug!(
                command = command,
                output_len = output.len(),
                "Command executed"
            );
        }
    }
}
