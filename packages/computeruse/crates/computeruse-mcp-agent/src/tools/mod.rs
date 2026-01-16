//! MCP tools module.
//
//! Contains implementations for individual MCP tools, keeping server.rs clean.

pub mod typecheck;

pub use typecheck::{typecheck_workflow, TypeError, TypecheckResult, TypecheckWorkflowArgs};
