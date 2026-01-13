#![allow(missing_docs)]

pub mod actions;
mod chunker;
mod plugin;
pub mod providers;
mod service;
mod types;

pub use actions::{
    get_actions, ActionContext, ActionError, ActionResult, KnowledgeAction, ProcessKnowledgeAction,
    SearchKnowledgeAction,
};
pub use chunker::TextChunker;
pub use plugin::KnowledgePlugin;
pub use providers::{
    DocumentsProvider, KnowledgeProvider, KnowledgeProviderTrait, ProviderContext, ProviderResult,
};
pub use service::KnowledgeService;
pub use types::*;

pub const VERSION: &str = "1.6.1";
pub const PLUGIN_NAME: &str = "knowledge";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(VERSION, "1.6.1");
    }

    #[test]
    fn test_plugin_name() {
        assert_eq!(PLUGIN_NAME, "knowledge");
    }
}
