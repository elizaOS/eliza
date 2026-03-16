//! Prose plugin providers

mod prose;

pub use prose::ProseProvider;

use crate::Provider;

/// Get all prose providers
pub fn get_prose_providers() -> Vec<Box<dyn Provider>> {
    vec![Box::new(ProseProvider::new())]
}
