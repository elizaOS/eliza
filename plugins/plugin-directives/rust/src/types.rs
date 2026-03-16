use serde::{Deserialize, Serialize};

// ============================================================================
// Directive Level Enums
// ============================================================================

/// Thinking level control for agent reasoning depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkLevel {
    Off,
    Concise,
    Verbose,
}

impl Default for ThinkLevel {
    fn default() -> Self {
        ThinkLevel::Off
    }
}

impl std::fmt::Display for ThinkLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThinkLevel::Off => write!(f, "off"),
            ThinkLevel::Concise => write!(f, "concise"),
            ThinkLevel::Verbose => write!(f, "verbose"),
        }
    }
}

/// Verbose output level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerboseLevel {
    Off,
    On,
}

impl Default for VerboseLevel {
    fn default() -> Self {
        VerboseLevel::Off
    }
}

impl std::fmt::Display for VerboseLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerboseLevel::Off => write!(f, "off"),
            VerboseLevel::On => write!(f, "on"),
        }
    }
}

/// Reasoning visibility level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningLevel {
    Off,
    Brief,
    Detailed,
}

impl Default for ReasoningLevel {
    fn default() -> Self {
        ReasoningLevel::Off
    }
}

impl std::fmt::Display for ReasoningLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReasoningLevel::Off => write!(f, "off"),
            ReasoningLevel::Brief => write!(f, "brief"),
            ReasoningLevel::Detailed => write!(f, "detailed"),
        }
    }
}

/// Elevated permissions level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElevatedLevel {
    Off,
    On,
}

impl Default for ElevatedLevel {
    fn default() -> Self {
        ElevatedLevel::Off
    }
}

impl std::fmt::Display for ElevatedLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElevatedLevel::Off => write!(f, "off"),
            ElevatedLevel::On => write!(f, "on"),
        }
    }
}

// ============================================================================
// Config Structs
// ============================================================================

/// Execution environment configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecConfig {
    pub enabled: bool,
    pub auto_approve: bool,
}

impl Default for ExecConfig {
    fn default() -> Self {
        ExecConfig {
            enabled: false,
            auto_approve: false,
        }
    }
}

/// Model selection configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
}

impl Default for ModelConfig {
    fn default() -> Self {
        ModelConfig {
            provider: None,
            model: None,
            temperature: None,
        }
    }
}

// ============================================================================
// Parsed Result & State
// ============================================================================

/// All directives parsed from a single message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedDirectives {
    /// Cleaned text with all directive markers removed.
    pub cleaned_text: String,
    /// Whether the message contained only directives and no other content.
    pub directives_only: bool,

    pub has_think: bool,
    pub think: Option<ThinkLevel>,

    pub has_verbose: bool,
    pub verbose: Option<VerboseLevel>,

    pub has_reasoning: bool,
    pub reasoning: Option<ReasoningLevel>,

    pub has_elevated: bool,
    pub elevated: Option<ElevatedLevel>,

    pub has_exec: bool,
    pub exec: Option<ExecConfig>,

    pub has_model: bool,
    pub model: Option<ModelConfig>,

    pub has_status: bool,
}

/// Full directive state for a session / room.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectiveState {
    pub thinking: ThinkLevel,
    pub verbose: VerboseLevel,
    pub reasoning: ReasoningLevel,
    pub elevated: ElevatedLevel,
    pub exec: ExecConfig,
    pub model: ModelConfig,
}

impl Default for DirectiveState {
    fn default() -> Self {
        DirectiveState {
            thinking: ThinkLevel::Off,
            verbose: VerboseLevel::Off,
            reasoning: ReasoningLevel::Off,
            elevated: ElevatedLevel::Off,
            exec: ExecConfig::default(),
            model: ModelConfig::default(),
        }
    }
}
