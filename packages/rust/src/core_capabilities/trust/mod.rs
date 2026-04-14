//! Trust capability — entity trust scoring, security monitoring, and access control.
//!
//! Ports the TypeScript `plugin-trust` module, providing:
//! - Trust dimensions, profiles, evidence, and decisions
//! - TrustEngineService for trust calculation
//! - SecurityModuleService for security event tracking
//! - RECORD_TRUST_INTERACTION, CHECK_TRUST actions
//! - TRUST_PROFILE, SECURITY_STATUS providers
//! - TRUST evaluator

pub mod actions;
pub mod evaluators;
pub mod providers;
pub mod security_module;
pub mod trust_engine;
pub mod types;

pub use actions::{CheckTrustAction, RecordTrustInteractionAction};
pub use evaluators::TrustEvaluator;
pub use providers::{SecurityStatusProvider, TrustProfileProvider};
pub use security_module::SecurityModuleService;
pub use trust_engine::TrustEngineService;
pub use types::*;
