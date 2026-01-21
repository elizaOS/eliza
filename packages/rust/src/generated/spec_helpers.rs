//! Helper functions to lookup action/provider/evaluator specs by name.
//!
//! These allow language-specific implementations to import their text content
//! (description, similes, examples) from the centralized specs.
//!
//! DO NOT EDIT the spec data - update packages/prompts/specs/** and regenerate.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;

use super::action_docs::{
    ALL_ACTION_DOCS_JSON, ALL_EVALUATOR_DOCS_JSON, ALL_PROVIDER_DOCS_JSON,
    CORE_ACTION_DOCS_JSON, CORE_EVALUATOR_DOCS_JSON, CORE_PROVIDER_DOCS_JSON,
};

/// Action document structure from the centralized specs.
#[derive(Debug, Clone, Deserialize)]
pub struct ActionDoc {
    /// Unique name identifier for the action.
    pub name: String,
    /// Human-readable description of what the action does.
    pub description: String,
    /// Alternative names that can trigger this action.
    #[serde(default)]
    pub similes: Vec<String>,
    /// Parameter definitions for the action.
    #[serde(default)]
    pub parameters: Vec<serde_json::Value>,
    /// Example conversations demonstrating the action.
    #[serde(default)]
    pub examples: Vec<Vec<serde_json::Value>>,
    /// Example action calls with parameters.
    #[serde(rename = "exampleCalls", default)]
    pub example_calls: Vec<serde_json::Value>,
}

/// Provider document structure from the centralized specs.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderDoc {
    /// Unique name identifier for the provider.
    pub name: String,
    /// Human-readable description of what the provider provides.
    pub description: String,
    /// Position in provider ordering (lower runs first).
    #[serde(default)]
    pub position: Option<i32>,
    /// Whether the provider generates dynamic content.
    #[serde(default)]
    pub dynamic: Option<bool>,
}

/// Evaluator document structure from the centralized specs.
#[derive(Debug, Clone, Deserialize)]
pub struct EvaluatorDoc {
    /// Unique name identifier for the evaluator.
    pub name: String,
    /// Human-readable description of what the evaluator does.
    pub description: String,
    /// Alternative names that can trigger this evaluator.
    #[serde(default)]
    pub similes: Vec<String>,
    /// Whether to run this evaluator on every message.
    #[serde(rename = "alwaysRun", default)]
    pub always_run: Option<bool>,
    /// Examples demonstrating the evaluator.
    #[serde(default)]
    pub examples: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct ActionsSpec {
    actions: Vec<ActionDoc>,
}

#[derive(Deserialize)]
struct ProvidersSpec {
    providers: Vec<ProviderDoc>,
}

#[derive(Deserialize)]
struct EvaluatorsSpec {
    evaluators: Vec<EvaluatorDoc>,
}

// Lazily initialize lookup maps
static CORE_ACTION_MAP: Lazy<HashMap<String, ActionDoc>> = Lazy::new(|| {
    let spec: ActionsSpec =
        serde_json::from_str(CORE_ACTION_DOCS_JSON).expect("Failed to parse core action docs");
    spec.actions
        .into_iter()
        .map(|a| (a.name.clone(), a))
        .collect()
});

static ALL_ACTION_MAP: Lazy<HashMap<String, ActionDoc>> = Lazy::new(|| {
    let spec: ActionsSpec =
        serde_json::from_str(ALL_ACTION_DOCS_JSON).expect("Failed to parse all action docs");
    spec.actions
        .into_iter()
        .map(|a| (a.name.clone(), a))
        .collect()
});

static CORE_PROVIDER_MAP: Lazy<HashMap<String, ProviderDoc>> = Lazy::new(|| {
    let spec: ProvidersSpec =
        serde_json::from_str(CORE_PROVIDER_DOCS_JSON).expect("Failed to parse core provider docs");
    spec.providers
        .into_iter()
        .map(|p| (p.name.clone(), p))
        .collect()
});

static ALL_PROVIDER_MAP: Lazy<HashMap<String, ProviderDoc>> = Lazy::new(|| {
    let spec: ProvidersSpec =
        serde_json::from_str(ALL_PROVIDER_DOCS_JSON).expect("Failed to parse all provider docs");
    spec.providers
        .into_iter()
        .map(|p| (p.name.clone(), p))
        .collect()
});

static CORE_EVALUATOR_MAP: Lazy<HashMap<String, EvaluatorDoc>> = Lazy::new(|| {
    let spec: EvaluatorsSpec = serde_json::from_str(CORE_EVALUATOR_DOCS_JSON)
        .expect("Failed to parse core evaluator docs");
    spec.evaluators
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect()
});

static ALL_EVALUATOR_MAP: Lazy<HashMap<String, EvaluatorDoc>> = Lazy::new(|| {
    let spec: EvaluatorsSpec =
        serde_json::from_str(ALL_EVALUATOR_DOCS_JSON).expect("Failed to parse all evaluator docs");
    spec.evaluators
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect()
});

/// Get an action spec by name from the core specs.
///
/// # Arguments
/// * `name` - The action name (e.g., "REPLY", "IGNORE")
///
/// # Returns
/// The action spec or None if not found
pub fn get_action_spec(name: &str) -> Option<&'static ActionDoc> {
    CORE_ACTION_MAP
        .get(name)
        .or_else(|| ALL_ACTION_MAP.get(name))
}

/// Get an action spec by name, panicking if not found.
///
/// # Arguments
/// * `name` - The action name
///
/// # Returns
/// The action spec
///
/// # Panics
/// Panics if the action is not found
pub fn require_action_spec(name: &str) -> &'static ActionDoc {
    get_action_spec(name).unwrap_or_else(|| panic!("Action spec not found: {}", name))
}

/// Get a provider spec by name from the core specs.
///
/// # Arguments
/// * `name` - The provider name (e.g., "CHARACTER", "TIME")
///
/// # Returns
/// The provider spec or None if not found
pub fn get_provider_spec(name: &str) -> Option<&'static ProviderDoc> {
    CORE_PROVIDER_MAP
        .get(name)
        .or_else(|| ALL_PROVIDER_MAP.get(name))
}

/// Get a provider spec by name, panicking if not found.
///
/// # Arguments
/// * `name` - The provider name
///
/// # Returns
/// The provider spec
///
/// # Panics
/// Panics if the provider is not found
pub fn require_provider_spec(name: &str) -> &'static ProviderDoc {
    get_provider_spec(name).unwrap_or_else(|| panic!("Provider spec not found: {}", name))
}

/// Get an evaluator spec by name from the core specs.
///
/// # Arguments
/// * `name` - The evaluator name (e.g., "REFLECTION")
///
/// # Returns
/// The evaluator spec or None if not found
pub fn get_evaluator_spec(name: &str) -> Option<&'static EvaluatorDoc> {
    CORE_EVALUATOR_MAP
        .get(name)
        .or_else(|| ALL_EVALUATOR_MAP.get(name))
}

/// Get an evaluator spec by name, panicking if not found.
///
/// # Arguments
/// * `name` - The evaluator name
///
/// # Returns
/// The evaluator spec
///
/// # Panics
/// Panics if the evaluator is not found
pub fn require_evaluator_spec(name: &str) -> &'static EvaluatorDoc {
    get_evaluator_spec(name).unwrap_or_else(|| panic!("Evaluator spec not found: {}", name))
}
