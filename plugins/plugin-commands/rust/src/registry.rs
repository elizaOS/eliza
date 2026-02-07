use std::collections::HashMap;

use crate::types::{CommandCategory, CommandDefinition};

/// Thread-safe command registry that stores command definitions and supports
/// lookup by name or alias.
#[derive(Debug, Clone)]
pub struct CommandRegistry {
    commands: Vec<CommandDefinition>,
    /// Maps normalised name/alias → index into `commands`.
    alias_map: HashMap<String, usize>,
}

impl CommandRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            commands: Vec::new(),
            alias_map: HashMap::new(),
        }
    }

    /// Register a command definition. Replaces any existing command with the
    /// same name and rebuilds the alias index.
    pub fn register(&mut self, def: CommandDefinition) {
        // Remove existing command with same name
        let norm = def.name.to_lowercase();
        self.commands.retain(|c| c.name.to_lowercase() != norm);

        self.commands.push(def);
        self.rebuild_alias_map();
    }

    /// Unregister a command by name. Returns `true` if a command was removed.
    pub fn unregister(&mut self, name: &str) -> bool {
        let norm = name.to_lowercase();
        let before = self.commands.len();
        self.commands.retain(|c| c.name.to_lowercase() != norm);
        let removed = self.commands.len() < before;
        if removed {
            self.rebuild_alias_map();
        }
        removed
    }

    /// Look up a command by name or alias. Returns `None` if not found.
    pub fn lookup(&self, name: &str) -> Option<&CommandDefinition> {
        let norm = name.to_lowercase();
        self.alias_map
            .get(&norm)
            .and_then(|&idx| self.commands.get(idx))
    }

    /// Return all registered commands (including hidden ones).
    pub fn list_all(&self) -> Vec<&CommandDefinition> {
        self.commands.iter().collect()
    }

    /// Return commands matching a specific category.
    pub fn list_by_category(&self, category: CommandCategory) -> Vec<&CommandDefinition> {
        self.commands
            .iter()
            .filter(|c| c.category == category)
            .collect()
    }

    /// Build a formatted help text string of all non-hidden commands.
    pub fn get_help_text(&self) -> String {
        let mut lines = vec!["**Available Commands:**".to_string(), String::new()];

        let categories = [
            CommandCategory::General,
            CommandCategory::Admin,
            CommandCategory::Debug,
            CommandCategory::Custom,
        ];

        for cat in &categories {
            let cmds: Vec<&CommandDefinition> = self
                .commands
                .iter()
                .filter(|c| c.category == *cat && !c.hidden)
                .collect();
            if cmds.is_empty() {
                continue;
            }

            lines.push(format!("**{}:**", cat));
            for cmd in cmds {
                let alias_str = if cmd.aliases.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", cmd.aliases.join(", "))
                };
                lines.push(format!(
                    "  /{}{} - {}",
                    cmd.name, alias_str, cmd.description
                ));
            }
            lines.push(String::new());
        }

        lines.join("\n")
    }

    /// Number of registered commands.
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    // ── Private ──────────────────────────────────────────────────────

    fn rebuild_alias_map(&mut self) {
        self.alias_map.clear();
        for (idx, cmd) in self.commands.iter().enumerate() {
            // Primary name
            self.alias_map
                .entry(cmd.name.to_lowercase())
                .or_insert(idx);
            // Aliases
            for alias in &cmd.aliases {
                self.alias_map
                    .entry(alias.to_lowercase())
                    .or_insert(idx);
            }
        }
    }
}

impl Default for CommandRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a registry pre-populated with the five built-in commands.
pub fn default_registry() -> CommandRegistry {
    let mut reg = CommandRegistry::new();

    reg.register(
        CommandDefinition::new("help", "Show available commands and their descriptions")
            .with_category(CommandCategory::General)
            .with_usage("/help")
            .with_aliases(vec!["h", "?"]),
    );

    reg.register(
        CommandDefinition::new("status", "Show current session status")
            .with_category(CommandCategory::General)
            .with_usage("/status")
            .with_aliases(vec!["s"]),
    );

    reg.register(
        CommandDefinition::new("stop", "Stop current operation")
            .with_category(CommandCategory::General)
            .with_usage("/stop")
            .with_aliases(vec!["abort", "cancel"]),
    );

    reg.register(
        CommandDefinition::new("models", "List available AI models")
            .with_category(CommandCategory::General)
            .with_usage("/models"),
    );

    reg.register(
        CommandDefinition::new("commands", "List all registered commands")
            .with_category(CommandCategory::General)
            .with_usage("/commands")
            .with_aliases(vec!["cmds"]),
    );

    reg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_lookup() {
        let mut reg = CommandRegistry::new();
        reg.register(CommandDefinition::new("ping", "Ping!"));
        assert!(reg.lookup("ping").is_some());
    }

    #[test]
    fn test_lookup_alias() {
        let mut reg = CommandRegistry::new();
        reg.register(
            CommandDefinition::new("help", "Show help").with_aliases(vec!["h", "?"]),
        );
        assert!(reg.lookup("h").is_some());
        assert!(reg.lookup("?").is_some());
        assert_eq!(reg.lookup("h").unwrap().name, "help");
    }

    #[test]
    fn test_unregister() {
        let mut reg = CommandRegistry::new();
        reg.register(CommandDefinition::new("temp", "Temporary"));
        assert!(reg.unregister("temp"));
        assert!(reg.lookup("temp").is_none());
        // Second unregister returns false
        assert!(!reg.unregister("temp"));
    }

    #[test]
    fn test_default_registry() {
        let reg = default_registry();
        assert_eq!(reg.len(), 5);
        assert!(reg.lookup("help").is_some());
        assert!(reg.lookup("status").is_some());
        assert!(reg.lookup("stop").is_some());
        assert!(reg.lookup("models").is_some());
        assert!(reg.lookup("commands").is_some());
    }
}
