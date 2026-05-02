//! Core Capabilities — essential services for agent operation.
//!
//! This module provides core capabilities that underpin agent trust,
//! security, secret management, and plugin lifecycle:
//!
//! - **trust** — Entity trust scoring, evidence tracking, and security monitoring
//! - **secrets** — Multi-level secret storage with encryption and access control
//! - **plugin_manager** — Runtime plugin lifecycle management (load/unload/status)

pub mod plugin_manager;
pub mod secrets;
pub mod trust;
