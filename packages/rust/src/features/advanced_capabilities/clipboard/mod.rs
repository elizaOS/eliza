//! Clipboard capability — file-based memory and task clipboard.
//!
//! Ports the TypeScript `plugin-clipboard` module, providing:
//! - ClipboardEntry, TaskClipboardItem types
//! - ClipboardService for storage and retrieval
//! - CLIPBOARD_ADD, CLIPBOARD_REMOVE, CLIPBOARD_CLEAR actions
//! - CLIPBOARD provider

pub mod actions;
pub mod clipboard_provider;
pub mod service;
pub mod types;

pub use actions::{ClipboardAddAction, ClipboardClearAction, ClipboardRemoveAction};
pub use clipboard_provider::ClipboardProvider;
pub use service::ClipboardService;
pub use types::*;
