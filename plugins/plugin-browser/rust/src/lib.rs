//! Browser Automation Plugin for ElizaOS (Rust)
//!
//! Provides AI-powered browser automation capabilities including:
//! - Navigation (navigate, back, forward, refresh)
//! - Interactions (click, type, select)
//! - Data extraction
//! - Screenshots
//! - CAPTCHA solving

pub mod types;
pub mod utils;
pub mod services;
pub mod actions;
pub mod providers;
pub mod plugin;

// Re-exports
pub use types::*;
pub use services::{BrowserService, BrowserWebSocketClient};
pub use actions::*;
pub use providers::*;
pub use plugin::{BrowserPlugin, create_browser_plugin};


