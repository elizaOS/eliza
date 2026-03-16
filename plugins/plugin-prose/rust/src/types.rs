//! Type definitions for plugin-prose

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// State management modes for OpenProse
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProseStateMode {
    #[default]
    Filesystem,
    #[serde(rename = "in-context")]
    InContext,
    Sqlite,
    Postgres,
}

impl ProseStateMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Filesystem => "filesystem",
            Self::InContext => "in-context",
            Self::Sqlite => "sqlite",
            Self::Postgres => "postgres",
        }
    }
}

impl std::fmt::Display for ProseStateMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Options for running a prose program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProseRunOptions {
    pub file: String,
    #[serde(default)]
    pub state_mode: ProseStateMode,
    pub inputs_json: Option<String>,
    pub cwd: Option<String>,
}

/// Options for compiling/validating a prose program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProseCompileOptions {
    pub file: String,
}

/// Result of running a prose program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProseRunResult {
    pub success: bool,
    pub run_id: Option<String>,
    pub outputs: Option<HashMap<String, serde_json::Value>>,
    pub error: Option<String>,
}

impl ProseRunResult {
    pub fn success(run_id: String, outputs: Option<HashMap<String, serde_json::Value>>) -> Self {
        Self {
            success: true,
            run_id: Some(run_id),
            outputs,
            error: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            run_id: None,
            outputs: None,
            error: Some(msg.into()),
        }
    }
}

/// Result of compiling/validating a prose program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProseCompileResult {
    pub valid: bool,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl ProseCompileResult {
    pub fn valid() -> Self {
        Self {
            valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub fn invalid(errors: Vec<String>, warnings: Vec<String>) -> Self {
        Self {
            valid: false,
            errors,
            warnings,
        }
    }
}

/// A skill file loaded by the prose service
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProseSkillFile {
    pub name: String,
    pub path: String,
    pub content: String,
}

/// Configuration for the Prose service
#[derive(Debug, Clone)]
pub struct ProseConfig {
    pub workspace_dir: String,
    pub default_state_mode: ProseStateMode,
    pub skills_dir: Option<String>,
}

impl Default for ProseConfig {
    fn default() -> Self {
        Self {
            workspace_dir: ".prose".to_string(),
            default_state_mode: ProseStateMode::Filesystem,
            skills_dir: None,
        }
    }
}

/// Builder for ProseConfig
#[derive(Debug, Default)]
pub struct ProseConfigBuilder {
    workspace_dir: Option<String>,
    default_state_mode: Option<ProseStateMode>,
    skills_dir: Option<String>,
}

impl ProseConfigBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn workspace_dir(mut self, dir: impl Into<String>) -> Self {
        self.workspace_dir = Some(dir.into());
        self
    }

    pub fn default_state_mode(mut self, mode: ProseStateMode) -> Self {
        self.default_state_mode = Some(mode);
        self
    }

    pub fn skills_dir(mut self, dir: impl Into<String>) -> Self {
        self.skills_dir = Some(dir.into());
        self
    }

    pub fn build(self) -> ProseConfig {
        ProseConfig {
            workspace_dir: self.workspace_dir.unwrap_or_else(|| ".prose".to_string()),
            default_state_mode: self.default_state_mode.unwrap_or_default(),
            skills_dir: self.skills_dir,
        }
    }
}
