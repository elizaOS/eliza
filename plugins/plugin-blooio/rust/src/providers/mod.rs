pub mod conversation_history;

pub use conversation_history::ConversationHistoryProvider;

/// Returns all providers supplied by the Blooio plugin.
pub fn get_blooio_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(ConversationHistoryProvider)]
}
