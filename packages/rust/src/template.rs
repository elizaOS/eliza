//! Prompt template rendering utilities.
//!
//! elizaOS prompt templates use Handlebars-style syntax (e.g. `{{agentName}}`).
//! This module provides a small, deterministic wrapper around the `handlebars` crate.

use anyhow::Result;
use handlebars::Handlebars;
use serde_json::Value;

/// Render a Handlebars template string using the provided JSON data.
pub fn render_template(template: &str, data: &Value) -> Result<String> {
    let mut h = Handlebars::new();
    // Default escaping is fine for plain-text prompts; we want deterministic output.
    h.register_template_string("t", template)?;
    Ok(h.render("t", data)?)
}
