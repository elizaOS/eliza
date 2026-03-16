//! Lobster plugin providers

mod lobster;

pub use lobster::LobsterProvider;

use crate::Provider;

/// Get all lobster providers
pub fn get_lobster_providers() -> Vec<Box<dyn Provider>> {
    vec![Box::new(LobsterProvider::new())]
}
