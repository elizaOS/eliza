//! Actions module for the Agent Skills plugin.
//!
//! Provides action handlers that delegate to [`AgentSkillsService`] for
//! skill discovery, installation, and execution.

pub mod search_skills;
pub mod get_skill_details;
pub mod get_skill_guidance;
pub mod sync_catalog;
pub mod run_skill_script;

pub use search_skills::SearchSkillsAction;
pub use get_skill_details::GetSkillDetailsAction;
pub use get_skill_guidance::GetSkillGuidanceAction;
pub use sync_catalog::SyncCatalogAction;
pub use run_skill_script::RunSkillScriptAction;

/// Common result type for action handlers.
#[derive(Debug, Clone)]
pub struct ActionResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Human-readable response text.
    pub text: String,
    /// Optional error message.
    pub error: Option<String>,
}

impl ActionResult {
    /// Create a success result.
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            success: true,
            text: text.into(),
            error: None,
        }
    }

    /// Create a failure result.
    pub fn fail(error: impl Into<String>) -> Self {
        let error = error.into();
        Self {
            success: false,
            text: error.clone(),
            error: Some(error),
        }
    }
}
