use crate::runtime::AgentRuntime;
use crate::types::plugin::Plugin;
use std::sync::Weak;

/// Session-compaction actions.
pub mod actions;
/// Evaluators for conversation summarization and long-term memory extraction.
pub mod evaluators;
/// Core memory service with session summary CRUD and extraction checkpointing.
pub mod memory_service;
/// LLM prompt templates for summarization and memory extraction.
pub mod prompts;
/// Providers for long-term memory and context summaries.
pub mod providers;
/// Type definitions for memory categories, sessions, and extraction results.
pub mod types;

pub use actions::ResetSessionAction;
pub use evaluators::long_term_extraction::LongTermExtractionEvaluator;
pub use evaluators::summarization::SummarizationEvaluator;
pub use memory_service::MemoryService;
pub use providers::context_summary::ContextSummaryProvider;
pub use providers::long_term_memory::LongTermMemoryProvider;

/// Create the advanced memory plugin with all providers and evaluators registered.
pub fn create_advanced_memory_plugin(runtime: Weak<AgentRuntime>) -> Plugin {
    let plugin = Plugin::new(
        "advanced_memory",
        "Advanced memory management with short-term summarization and long-term persistent facts",
    );

    if let Some(rt) = runtime.upgrade() {
        let weak = std::sync::Arc::downgrade(&rt);
        let reset_action = std::sync::Arc::new(ResetSessionAction::new(weak.clone()));
        let provider = std::sync::Arc::new(LongTermMemoryProvider::new(weak.clone()));
        let context_provider = std::sync::Arc::new(ContextSummaryProvider::new(weak.clone()));
        let summarization_eval = std::sync::Arc::new(SummarizationEvaluator::new(weak.clone()));
        let extraction_eval = std::sync::Arc::new(LongTermExtractionEvaluator::new(weak));

        return plugin
            .with_action(reset_action)
            .with_provider(provider)
            .with_provider(context_provider)
            .with_evaluator(summarization_eval)
            .with_evaluator(extraction_eval);
    }

    plugin
}
