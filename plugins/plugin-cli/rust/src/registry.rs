use std::collections::HashMap;

use crate::types::CliCommand;

/// Central registry for CLI commands.
///
/// Commands are stored by their primary name and can be looked up by name or alias.
#[derive(Debug, Clone)]
pub struct CliRegistry {
    commands: HashMap<String, CliCommand>,
}

impl CliRegistry {
    /// Create a new, empty registry.
    pub fn new() -> Self {
        Self {
            commands: HashMap::new(),
        }
    }

    /// Register a command. If a command with the same name already exists, it is replaced
    /// and the old command is returned.
    pub fn register_command(&mut self, cmd: CliCommand) -> Option<CliCommand> {
        tracing::debug!("Registering CLI command: {}", cmd.name);
        self.commands.insert(cmd.name.clone(), cmd)
    }

    /// Unregister a command by its primary name. Returns the removed command if found.
    pub fn unregister_command(&mut self, name: &str) -> Option<CliCommand> {
        self.commands.remove(name)
    }

    /// Get a command by its primary name.
    pub fn get_command(&self, name: &str) -> Option<&CliCommand> {
        self.commands.get(name)
    }

    /// Find a command by name or any of its aliases.
    pub fn find_command(&self, name: &str) -> Option<&CliCommand> {
        // Direct name lookup first (fast path).
        if let Some(cmd) = self.commands.get(name) {
            return Some(cmd);
        }
        // Fall back to alias scan.
        self.commands.values().find(|cmd| cmd.matches(name))
    }

    /// List all registered commands, sorted by priority then name.
    pub fn list_commands(&self) -> Vec<&CliCommand> {
        let mut cmds: Vec<&CliCommand> = self.commands.values().collect();
        cmds.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.name.cmp(&b.name)));
        cmds
    }

    /// Check if a command with the given primary name is registered.
    pub fn has_command(&self, name: &str) -> bool {
        self.commands.contains_key(name)
    }

    /// Return the number of registered commands.
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    /// Remove all commands.
    pub fn clear(&mut self) {
        self.commands.clear();
    }

    /// Get all command names (primary names only).
    pub fn command_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.commands.keys().map(|s| s.as_str()).collect();
        names.sort();
        names
    }
}

impl Default for CliRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper to define a CLI command with a builder-like API, then register it.
///
/// # Example
/// ```
/// use elizaos_plugin_cli::{CliRegistry, CliCommand, CliArg};
///
/// let mut registry = CliRegistry::new();
/// let cmd = CliCommand::new("run", "Run the agent", "handle_run")
///     .with_alias("start")
///     .with_arg(CliArg::optional("port", "Listen port", "3000"))
///     .with_priority(10);
/// registry.register_command(cmd);
///
/// assert!(registry.has_command("run"));
/// ```
pub fn define_and_register(registry: &mut CliRegistry, cmd: CliCommand) {
    registry.register_command(cmd);
}
