//! Plugin types for elizaOS
//!
//! Contains Plugin, Route, and related types for extending agent functionality.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use super::agent::Character;
use super::components::{
    ActionDefinition, ActionHandler, EvaluatorDefinition, EvaluatorHandler, ProviderDefinition,
    ProviderHandler,
};
use super::testing::TestSuite;

/// HTTP method types for routes
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    /// GET request
    Get,
    /// POST request
    Post,
    /// PUT request
    Put,
    /// PATCH request
    Patch,
    /// DELETE request
    Delete,
    /// Static file serving
    Static,
}

/// Route definition for HTTP endpoints
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDefinition {
    /// HTTP method type
    #[serde(rename = "type")]
    pub method: HttpMethod,
    /// Route path
    pub path: String,
    /// File path for static routes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// Whether the route is public
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public: Option<bool>,
    /// Route name (required for public routes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Whether the route expects multipart/form-data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_multipart: Option<bool>,
}

/// Component type definition for entities
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentTypeDefinition {
    /// Component type name
    pub name: String,
    /// JSON schema for validation
    pub schema: HashMap<String, serde_json::Value>,
}

/// Plugin definition for serialization (without handlers)
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDefinition {
    /// Plugin name
    pub name: String,
    /// Plugin description
    pub description: String,
    /// Plugin configuration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, serde_json::Value>>,
    /// Entity component definitions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_types: Option<Vec<ComponentTypeDefinition>>,
    /// Action definitions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ActionDefinition>>,
    /// Provider definitions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<ProviderDefinition>>,
    /// Evaluator definitions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluators: Option<Vec<EvaluatorDefinition>>,
    /// Route definitions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routes: Option<Vec<RouteDefinition>>,
    /// Plugin dependencies
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<String>>,
    /// Test dependencies
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_dependencies: Option<Vec<String>>,
    /// Plugin priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    /// Plugin schema
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<HashMap<String, serde_json::Value>>,
}

/// Model handler function type (async function that takes params and returns result)
///
/// This type is used for model handlers registered via plugins. It takes JSON
/// parameters and returns a string result asynchronously.
///
/// For native builds, handlers must be Send + Sync for multi-threaded async.
/// For WASM builds, this constraint is relaxed since WASM is single-threaded.
#[cfg(not(feature = "wasm"))]
pub type ModelHandlerFn = Box<
    dyn Fn(
            serde_json::Value,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>>
        + Send
        + Sync,
>;

/// Model handler function type for WASM builds
///
/// This type is used for model handlers registered via plugins. The WASM version
/// does not require Send + Sync since WebAssembly is single-threaded.
#[cfg(feature = "wasm")]
pub type ModelHandlerFn = Box<
    dyn Fn(
        serde_json::Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>>>>,
>;

/// Full plugin with handlers (runtime representation)
#[derive(Default)]
pub struct Plugin {
    /// Plugin definition (serializable metadata)
    pub definition: PluginDefinition,
    /// Action handlers
    pub action_handlers: Vec<Arc<dyn ActionHandler>>,
    /// Provider handlers
    pub provider_handlers: Vec<Arc<dyn ProviderHandler>>,
    /// Evaluator handlers
    pub evaluator_handlers: Vec<Arc<dyn EvaluatorHandler>>,
    /// Model handlers (maps model type like "TEXT_LARGE" to handler)
    pub model_handlers: HashMap<String, ModelHandlerFn>,
    /// Test suites
    pub tests: Vec<TestSuite>,
    /// Initialization function
    pub init: Option<PluginInitFn>,
}

/// Type alias for plugin initialization function
type PluginInitFn = Box<dyn Fn(HashMap<String, String>) -> Result<(), anyhow::Error> + Send + Sync>;

impl Plugin {
    /// Create a new plugin with a name and description
    pub fn new(name: &str, description: &str) -> Self {
        Plugin {
            definition: PluginDefinition {
                name: name.to_string(),
                description: description.to_string(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Get the plugin name
    pub fn name(&self) -> &str {
        &self.definition.name
    }

    /// Get the plugin description
    pub fn description(&self) -> &str {
        &self.definition.description
    }

    /// Get dependencies
    pub fn dependencies(&self) -> &[String] {
        self.definition.dependencies.as_deref().unwrap_or(&[])
    }

    /// Get test dependencies
    pub fn test_dependencies(&self) -> &[String] {
        self.definition.test_dependencies.as_deref().unwrap_or(&[])
    }

    /// Add an action handler
    pub fn with_action(mut self, handler: Arc<dyn ActionHandler>) -> Self {
        let def = handler.definition();
        if let Some(ref mut actions) = self.definition.actions {
            actions.push(def);
        } else {
            self.definition.actions = Some(vec![def]);
        }
        self.action_handlers.push(handler);
        self
    }

    /// Add a provider handler
    pub fn with_provider(mut self, handler: Arc<dyn ProviderHandler>) -> Self {
        let def = handler.definition();
        if let Some(ref mut providers) = self.definition.providers {
            providers.push(def);
        } else {
            self.definition.providers = Some(vec![def]);
        }
        self.provider_handlers.push(handler);
        self
    }

    /// Add an evaluator handler
    pub fn with_evaluator(mut self, handler: Arc<dyn EvaluatorHandler>) -> Self {
        let def = handler.definition();
        if let Some(ref mut evaluators) = self.definition.evaluators {
            evaluators.push(def);
        } else {
            self.definition.evaluators = Some(vec![def]);
        }
        self.evaluator_handlers.push(handler);
        self
    }

    /// Add route definitions
    pub fn with_routes(mut self, routes: Vec<RouteDefinition>) -> Self {
        if let Some(ref mut existing) = self.definition.routes {
            existing.extend(routes);
        } else {
            self.definition.routes = Some(routes);
        }
        self
    }
}

/// Project agent configuration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentDefinition {
    /// Character configuration
    pub character: Character,
    /// Plugin names to load
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugins: Option<Vec<String>>,
}

/// Project configuration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDefinition {
    /// Agent configurations
    pub agents: Vec<ProjectAgentDefinition>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_definition_serialization() {
        let plugin = PluginDefinition {
            name: "test-plugin".to_string(),
            description: "A test plugin".to_string(),
            dependencies: Some(vec!["other-plugin".to_string()]),
            ..Default::default()
        };

        let json = serde_json::to_string(&plugin).unwrap();
        assert!(json.contains("\"name\":\"test-plugin\""));
        assert!(json.contains("\"dependencies\":[\"other-plugin\"]"));
    }

    #[test]
    fn test_route_definition_serialization() {
        let route = RouteDefinition {
            method: HttpMethod::Get,
            path: "/api/test".to_string(),
            file_path: None,
            public: Some(true),
            name: Some("Test Route".to_string()),
            is_multipart: None,
        };

        let json = serde_json::to_string(&route).unwrap();
        assert!(json.contains("\"type\":\"GET\""));
        assert!(json.contains("\"path\":\"/api/test\""));
    }
}
