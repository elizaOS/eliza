//! elizaOS Scheduling Plugin - Rust Implementation
//!
//! Provides:
//! - Multi-party availability coordination
//! - Meeting scheduling with time slot proposals
//! - Calendar invite generation (ICS format)
//! - Automated reminders
//! - Rescheduling and cancellation handling
//!
//! # Example
//!
//! ```rust,no_run
//! use std::sync::Arc;
//! use elizaos_plugin_scheduling::{
//!     config::SchedulingServiceConfig,
//!     service::SchedulingService,
//!     storage::*,
//! };
//!
//! let config = SchedulingServiceConfig::default();
//! let service = SchedulingService::new(
//!     config,
//!     Arc::new(InMemoryAvailabilityStorage::new()),
//!     Arc::new(InMemorySchedulingRequestStorage::new()),
//!     Arc::new(InMemoryMeetingStorage::new()),
//!     Arc::new(InMemoryReminderStorage::new()),
//! );
//! ```

pub mod actions;
pub mod config;
pub mod error;
pub mod ical;
pub mod providers;
pub mod service;
pub mod storage;
pub mod types;

// Re-exports for convenience
pub use config::SchedulingServiceConfig;
pub use error::{Result, SchedulingError};
pub use service::SchedulingService;
