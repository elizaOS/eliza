//! Form capability — agent-guided user journey forms.
//!
//! Ports the TypeScript `advanced-capabilities/form` module, providing:
//! - FormControl, FormDefinition, FormSession, FormSubmission types
//! - FormService for managing form lifecycle
//! - FORM_RESTORE action
//! - FORM_CONTEXT provider
//! - FORM_EXTRACTOR evaluator

pub mod context;
pub mod extractor;
pub mod restore;
pub mod service;
pub mod types;

pub use context::FormContextProvider;
pub use extractor::FormExtractorEvaluator;
pub use restore::FormRestoreAction;
pub use service::FormService;
pub use types::*;
