#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

mod types;
pub mod parsers;
pub mod providers;

pub use parsers::{
    apply_directives, extract_elevated_directive, extract_exec_directive,
    extract_model_directive, extract_reasoning_directive, extract_status_directive,
    extract_think_directive, extract_verbose_directive, format_directive_state,
    normalize_elevated_level, normalize_exec, normalize_reasoning_level, normalize_think_level,
    normalize_verbose_level, parse_all_directives, strip_directives,
};
pub use providers::{get_directive_providers, DirectiveStateProvider};
pub use types::{
    DirectiveState, ElevatedLevel, ExecConfig, ModelConfig, ParsedDirectives, ReasoningLevel,
    ThinkLevel, VerboseLevel,
};

pub const PLUGIN_NAME: &str = "directives";
pub const PLUGIN_DESCRIPTION: &str =
    "Inline directive parsing (/think, /model, /verbose, etc.) for controlling agent behavior";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

// ============================================================================
// Trait Definitions (mirroring plugin-code gold standard)
// ============================================================================

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: Value,
    pub text: String,
    pub data: Value,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn position(&self) -> i32;
    async fn get(&self, message: &Value, state: &Value) -> ProviderResult;
}

// ============================================================================
// Prelude
// ============================================================================

pub mod prelude {
    pub use crate::parsers::{
        apply_directives, extract_elevated_directive, extract_exec_directive,
        extract_model_directive, extract_reasoning_directive, extract_status_directive,
        extract_think_directive, extract_verbose_directive, format_directive_state,
        parse_all_directives, strip_directives,
    };
    pub use crate::providers::{get_directive_providers, DirectiveStateProvider};
    pub use crate::types::{
        DirectiveState, ElevatedLevel, ExecConfig, ModelConfig, ParsedDirectives, ReasoningLevel,
        ThinkLevel, VerboseLevel,
    };
    pub use crate::{Provider, ProviderResult, PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};
}
