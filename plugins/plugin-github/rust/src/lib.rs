#![allow(missing_docs)]
#![allow(clippy::result_large_err)]
#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

// Re-exports for convenience
pub use config::GitHubConfig;
pub use error::{GitHubError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use service::GitHubService;

#[cfg(feature = "native")]
pub use actions::{
    ActionContext, CreateBranchAction, CreateCommentAction, CreateIssueAction,
    CreatePullRequestAction, GitHubAction, MergePullRequestAction, PushCodeAction,
    ReviewPullRequestAction,
};

pub const PLUGIN_NAME: &str = "github";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PLUGIN_DESCRIPTION: &str = "GitHub integration for elizaOS agents";

#[derive(Debug, Clone)]
pub struct Plugin {
    pub name: String,
    pub description: String,
    pub version: String,
}

pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_creation() {
        let p = plugin();
        assert_eq!(p.name, PLUGIN_NAME);
        assert!(!p.description.is_empty());
    }
}
