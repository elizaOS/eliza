//! Providers for the shell plugin.
//!
//! This module provides context providers for shell state and history.

pub mod shell_history;

pub use shell_history::ShellHistoryProvider;

/// All shell providers as a vector.
pub fn get_shell_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(ShellHistoryProvider)]
}
