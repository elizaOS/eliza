//! MCP Elicitation Support
//!
//! This module provides elicitation schemas and helper functions for requesting
//! structured user input during tool execution via MCP.
//!
//! ## Overview
//!
//! Elicitation allows the MCP server to ask clarifying questions about:
//! - Business logic and workflow context
//! - Element disambiguation when multiple elements match
//! - Error recovery strategies
//! - Confirmation for destructive actions
//!
//! ## Client Support
//!
//! As of December 2025, Claude Desktop and Claude Code do not yet support
//! elicitation. The implementation includes graceful fallback for unsupported
//! clients.
//!
//! ## Example
//!
//! ```ignore
//! use computeruse_mcp_agent::elicitation::{elicit_with_fallback, WorkflowContext};
//!
//! async fn my_tool(peer: &Peer<RoleServer>) {
//!     let ctx = elicit_with_fallback(
//!         peer,
//!         "What is this workflow for?",
//!         WorkflowContext::default(),
//!     ).await;
//!
//!     println!("Purpose: {}", ctx.business_purpose);
//! }
//! ```

mod helpers;
mod schemas;

#[cfg(test)]
mod tests;

// Re-export schemas
pub use schemas::{
    ActionConfirmation, ElementDisambiguation, ElementTypeHint, ErrorRecoveryAction,
    ErrorRecoveryChoice, SelectorRefinement, UserResponse, WorkflowContext,
};

// Re-export helpers
pub use helpers::{elicit_with_fallback, supports_elicitation, try_elicit, try_elicit_raw};

// Re-export the elicit_safe macro
pub use rmcp::elicit_safe;
