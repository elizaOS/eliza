use serde::{Deserialize, Serialize};

/// Categories for organizing commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandCategory {
    General,
    Admin,
    Debug,
    Custom,
}

impl std::fmt::Display for CommandCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::General => write!(f, "General"),
            Self::Admin => write!(f, "Admin"),
            Self::Debug => write!(f, "Debug"),
            Self::Custom => write!(f, "Custom"),
        }
    }
}

/// Definition of a registerable command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandDefinition {
    pub name: String,
    pub description: String,
    pub category: CommandCategory,
    pub usage: String,
    pub aliases: Vec<String>,
    pub hidden: bool,
}

impl CommandDefinition {
    pub fn new(name: &str, description: &str) -> Self {
        Self {
            name: name.to_lowercase(),
            description: description.to_string(),
            category: CommandCategory::General,
            usage: format!("/{}", name.to_lowercase()),
            aliases: Vec::new(),
            hidden: false,
        }
    }

    pub fn with_category(mut self, category: CommandCategory) -> Self {
        self.category = category;
        self
    }

    pub fn with_usage(mut self, usage: &str) -> Self {
        self.usage = usage.to_string();
        self
    }

    pub fn with_aliases(mut self, aliases: Vec<&str>) -> Self {
        self.aliases = aliases.into_iter().map(|s| s.to_lowercase()).collect();
        self
    }

    pub fn with_hidden(mut self, hidden: bool) -> Self {
        self.hidden = hidden;
        self
    }
}

/// Context available when executing a command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandContext {
    pub runtime_id: String,
    pub room_id: String,
    pub agent_id: String,
}

/// Result returned from a command handler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub text: String,
    pub data: Option<serde_json::Value>,
}

impl CommandResult {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            success: true,
            text: text.into(),
            data: None,
        }
    }

    pub fn ok_with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            success: true,
            text: text.into(),
            data: Some(data),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            success: false,
            text: text.into(),
            data: None,
        }
    }
}

/// A parsed command extracted from user input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedCommand {
    pub name: String,
    pub args: Vec<String>,
    pub raw_text: String,
}
