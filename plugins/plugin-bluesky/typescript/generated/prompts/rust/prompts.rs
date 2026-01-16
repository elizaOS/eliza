//! Auto-generated prompt templates
//! DO NOT EDIT - Generated from ../../../../prompts/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

pub const GENERATE_DM_TEMPLATE: &str = r#"Generate a friendly direct message response under 200 characters."#;

pub const GENERATE_POST_TEMPLATE: &str = r#"Generate an engaging BlueSky post under {{maxLength}} characters."#;

pub const TRUNCATE_POST_TEMPLATE: &str = r#"Shorten to under {{maxLength}} characters: "{{text}}""#;

