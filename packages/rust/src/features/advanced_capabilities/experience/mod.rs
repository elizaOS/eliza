//! Experience capability — agent learning and experience tracking.
//!
//! Ports the TypeScript `advanced-capabilities/experience` module, providing:
//! - Experience types (Success, Failure, Discovery, Correction, etc.)
//! - ExperienceService for storage and retrieval
//! - RECORD_EXPERIENCE action
//! - EXPERIENCE provider (injects relevant past experiences into context)
//! - EXPERIENCE evaluator (auto-records experiences from conversation signals)

pub mod experience_evaluator;
pub mod experience_provider;
pub mod record_experience;
pub mod service;
pub mod types;

pub use experience_evaluator::ExperienceEvaluator;
pub use experience_provider::ExperienceProvider;
pub use record_experience::RecordExperienceAction;
pub use service::ExperienceService;
pub use types::*;
