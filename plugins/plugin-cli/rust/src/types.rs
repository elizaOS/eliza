use serde::{Deserialize, Serialize};

/// Context provided to CLI command handlers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliContext {
    /// Program name (e.g. "elizaos", "otto").
    pub program_name: String,
    /// CLI version string.
    pub version: String,
    /// Human-readable description of the CLI.
    pub description: String,
    /// Optional workspace directory for file operations.
    pub workspace_dir: Option<String>,
    /// Optional configuration key-value pairs.
    pub config: Option<std::collections::HashMap<String, serde_json::Value>>,
}

impl CliContext {
    /// Create a new CLI context with the given program name, version, and description.
    pub fn new(program_name: impl Into<String>, version: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            program_name: program_name.into(),
            version: version.into(),
            description: description.into(),
            workspace_dir: None,
            config: None,
        }
    }

    /// Set the workspace directory.
    pub fn with_workspace_dir(mut self, dir: impl Into<String>) -> Self {
        self.workspace_dir = Some(dir.into());
        self
    }

    /// Set configuration.
    pub fn with_config(mut self, config: std::collections::HashMap<String, serde_json::Value>) -> Self {
        self.config = Some(config);
        self
    }
}

/// A single argument definition for a CLI command.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliArg {
    /// Argument name (e.g. "output", "verbose").
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Whether this argument is required.
    pub required: bool,
    /// Optional default value when not supplied.
    pub default_value: Option<String>,
}

impl CliArg {
    /// Create a new required argument.
    pub fn required(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            required: true,
            default_value: None,
        }
    }

    /// Create a new optional argument with a default value.
    pub fn optional(name: impl Into<String>, description: impl Into<String>, default: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            required: false,
            default_value: Some(default.into()),
        }
    }
}

/// Definition of a CLI command that can be registered in the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliCommand {
    /// Primary command name (e.g. "run", "config").
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Alternate names for this command.
    pub aliases: Vec<String>,
    /// Name of the handler function to invoke.
    pub handler_name: String,
    /// Arguments accepted by this command.
    pub args: Vec<CliArg>,
    /// Priority for registration order (lower = earlier).
    pub priority: i32,
}

impl CliCommand {
    /// Create a new command with required fields.
    pub fn new(name: impl Into<String>, description: impl Into<String>, handler_name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            aliases: Vec::new(),
            handler_name: handler_name.into(),
            args: Vec::new(),
            priority: 100,
        }
    }

    /// Add an alias.
    pub fn with_alias(mut self, alias: impl Into<String>) -> Self {
        self.aliases.push(alias.into());
        self
    }

    /// Add multiple aliases.
    pub fn with_aliases(mut self, aliases: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.aliases.extend(aliases.into_iter().map(|a| a.into()));
        self
    }

    /// Add an argument.
    pub fn with_arg(mut self, arg: CliArg) -> Self {
        self.args.push(arg);
        self
    }

    /// Set priority.
    pub fn with_priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    /// Check if this command matches a name or any of its aliases.
    pub fn matches(&self, name: &str) -> bool {
        self.name == name || self.aliases.iter().any(|a| a == name)
    }
}

/// Trait for CLI log output, allowing pluggable logging backends.
#[allow(unused_variables)]
pub trait CliLogger: Send + Sync {
    /// Log an informational message.
    fn info(&self, msg: &str);
    /// Log a warning message.
    fn warn(&self, msg: &str);
    /// Log an error message.
    fn error(&self, msg: &str);
    /// Log a debug message (optional, defaults to no-op).
    fn debug(&self, msg: &str) {}
}

/// A default logger that writes to stdout/stderr via `tracing`.
#[derive(Debug, Clone, Default)]
pub struct DefaultCliLogger;

impl CliLogger for DefaultCliLogger {
    fn info(&self, msg: &str) {
        tracing::info!("{}", msg);
    }

    fn warn(&self, msg: &str) {
        tracing::warn!("{}", msg);
    }

    fn error(&self, msg: &str) {
        tracing::error!("{}", msg);
    }

    fn debug(&self, msg: &str) {
        tracing::debug!("{}", msg);
    }
}

/// Tracks progress of a long-running operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressReporter {
    /// Current step number.
    pub current: u64,
    /// Total number of steps (0 if unknown).
    pub total: u64,
    /// Current status message.
    pub message: String,
}

impl ProgressReporter {
    /// Create a new progress reporter.
    pub fn new(total: u64, message: impl Into<String>) -> Self {
        Self {
            current: 0,
            total,
            message: message.into(),
        }
    }

    /// Advance by one step with a new message.
    pub fn advance(&mut self, message: impl Into<String>) {
        self.current = self.current.saturating_add(1);
        self.message = message.into();
    }

    /// Set absolute progress.
    pub fn set(&mut self, current: u64, message: impl Into<String>) {
        self.current = current;
        self.message = message.into();
    }

    /// Returns progress as a fraction in [0.0, 1.0], or `None` if total is 0.
    pub fn fraction(&self) -> Option<f64> {
        if self.total == 0 {
            None
        } else {
            Some((self.current as f64) / (self.total as f64))
        }
    }

    /// Whether the operation is complete.
    pub fn is_complete(&self) -> bool {
        self.total > 0 && self.current >= self.total
    }

    /// Format as a human-readable string like "[3/10] Building..."
    pub fn display(&self) -> String {
        if self.total > 0 {
            format!("[{}/{}] {}", self.current, self.total, self.message)
        } else {
            format!("[{}] {}", self.current, self.message)
        }
    }
}

/// Common options that many CLI commands accept.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommonCommandOptions {
    /// Output as JSON.
    pub json: bool,
    /// Verbose output.
    pub verbose: bool,
    /// Quiet mode (minimal output).
    pub quiet: bool,
    /// Force action without confirmation.
    pub force: bool,
    /// Dry run (show what would happen).
    pub dry_run: bool,
}

/// Result of parsing a duration string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDuration {
    /// Duration in milliseconds.
    pub ms: u64,
    /// The original input string.
    pub original: String,
    /// Whether parsing succeeded.
    pub valid: bool,
}

/// CLI plugin configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliPluginConfig {
    /// CLI name.
    pub name: String,
    /// CLI version.
    pub version: String,
}

impl Default for CliPluginConfig {
    fn default() -> Self {
        Self {
            name: crate::DEFAULT_CLI_NAME.to_string(),
            version: crate::DEFAULT_CLI_VERSION.to_string(),
        }
    }
}
