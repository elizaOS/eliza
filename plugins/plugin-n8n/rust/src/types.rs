//! Type definitions for the N8n Plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::models::JobStatus;

/// Specification for a plugin action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSpecification {
    /// The action name.
    pub name: String,
    /// The action description.
    pub description: String,
    /// Optional parameters for the action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<HashMap<String, serde_json::Value>>,
}

/// Specification for a plugin provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpecification {
    /// The provider name.
    pub name: String,
    /// The provider description.
    pub description: String,
    /// Optional data structure specification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_structure: Option<HashMap<String, serde_json::Value>>,
}

/// Specification for a plugin service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceSpecification {
    /// The service name.
    pub name: String,
    /// The service description.
    pub description: String,
    /// Optional list of methods.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub methods: Option<Vec<String>>,
}

/// Specification for a plugin evaluator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorSpecification {
    /// The evaluator name.
    pub name: String,
    /// The evaluator description.
    pub description: String,
    /// Optional list of triggers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<String>>,
}

/// Environment variable specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentVariableSpec {
    /// The variable name.
    pub name: String,
    /// The variable description.
    pub description: String,
    /// Whether the variable is required.
    pub required: bool,
    /// Whether the variable is sensitive.
    pub sensitive: bool,
}

/// Complete specification for creating a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSpecification {
    /// The plugin name (e.g., "@elizaos/plugin-example").
    pub name: String,
    /// The plugin description.
    pub description: String,
    /// The plugin version.
    #[serde(default = "default_version")]
    pub version: String,
    /// Optional list of actions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ActionSpecification>>,
    /// Optional list of providers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<ProviderSpecification>>,
    /// Optional list of services.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<Vec<ServiceSpecification>>,
    /// Optional list of evaluators.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluators: Option<Vec<EvaluatorSpecification>>,
    /// Optional dependencies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<HashMap<String, String>>,
    /// Optional environment variables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_variables: Option<Vec<EnvironmentVariableSpec>>,
}

fn default_version() -> String {
    "1.0.0".to_string()
}

impl PluginSpecification {
    /// Create a new plugin specification builder.
    pub fn builder() -> PluginSpecificationBuilder {
        PluginSpecificationBuilder::default()
    }
}

/// Builder for PluginSpecification.
#[derive(Debug, Default)]
pub struct PluginSpecificationBuilder {
    name: Option<String>,
    description: Option<String>,
    version: String,
    actions: Option<Vec<ActionSpecification>>,
    providers: Option<Vec<ProviderSpecification>>,
    services: Option<Vec<ServiceSpecification>>,
    evaluators: Option<Vec<EvaluatorSpecification>>,
    dependencies: Option<HashMap<String, String>>,
    environment_variables: Option<Vec<EnvironmentVariableSpec>>,
}

impl PluginSpecificationBuilder {
    /// Set the plugin name.
    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Set the plugin description.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the plugin version.
    pub fn version(mut self, version: impl Into<String>) -> Self {
        self.version = version.into();
        self
    }

    /// Add an action.
    pub fn action(mut self, action: ActionSpecification) -> Self {
        self.actions.get_or_insert_with(Vec::new).push(action);
        self
    }

    /// Add a provider.
    pub fn provider(mut self, provider: ProviderSpecification) -> Self {
        self.providers.get_or_insert_with(Vec::new).push(provider);
        self
    }

    /// Add a service.
    pub fn service(mut self, service: ServiceSpecification) -> Self {
        self.services.get_or_insert_with(Vec::new).push(service);
        self
    }

    /// Add an evaluator.
    pub fn evaluator(mut self, evaluator: EvaluatorSpecification) -> Self {
        self.evaluators.get_or_insert_with(Vec::new).push(evaluator);
        self
    }

    /// Build the specification.
    pub fn build(self) -> Result<PluginSpecification, &'static str> {
        Ok(PluginSpecification {
            name: self.name.ok_or("name is required")?,
            description: self.description.ok_or("description is required")?,
            version: if self.version.is_empty() {
                default_version()
            } else {
                self.version
            },
            actions: self.actions,
            providers: self.providers,
            services: self.services,
            evaluators: self.evaluators,
            dependencies: self.dependencies,
            environment_variables: self.environment_variables,
        })
    }
}

/// Error that occurred during plugin creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobError {
    /// The iteration number when the error occurred.
    pub iteration: u32,
    /// The phase when the error occurred.
    pub phase: String,
    /// The error message.
    pub error: String,
    /// When the error occurred.
    pub timestamp: DateTime<Utc>,
}

/// Test results from plugin validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResults {
    /// Number of passed tests.
    pub passed: u32,
    /// Number of failed tests.
    pub failed: u32,
    /// Test duration in seconds.
    pub duration: f64,
}

/// A plugin creation job tracking object.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCreationJob {
    /// The job ID.
    pub id: String,
    /// The plugin specification.
    pub specification: PluginSpecification,
    /// Current job status.
    pub status: JobStatus,
    /// Current phase.
    pub current_phase: String,
    /// Progress percentage (0-100).
    pub progress: f64,
    /// Log entries.
    pub logs: Vec<String>,
    /// Error message if failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Result message if completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Output path for generated plugin.
    pub output_path: String,
    /// When the job started.
    pub started_at: DateTime<Utc>,
    /// When the job completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Current iteration number.
    pub current_iteration: u32,
    /// Maximum iterations allowed.
    pub max_iterations: u32,
    /// Test results if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_results: Option<TestResults>,
    /// Validation score if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_score: Option<f64>,
    /// List of errors that occurred.
    pub errors: Vec<JobError>,
    /// The model used for generation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_used: Option<String>,
}

/// Options for creating a plugin.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePluginOptions {
    /// Whether to use a template.
    #[serde(default = "default_use_template")]
    pub use_template: bool,
    /// The model to use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn default_use_template() -> bool {
    true
}

/// Information about a created plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// The plugin name.
    pub name: String,
    /// The job ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Current status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<JobStatus>,
    /// Current phase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// Progress percentage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    /// When started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    /// When completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Model used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_used: Option<String>,
}

/// Plugin registry data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryData {
    /// Total number of created plugins.
    pub total_created: usize,
    /// List of plugin info.
    pub plugins: Vec<PluginInfo>,
    /// Number of active jobs.
    pub active_jobs: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_specification_builder() {
        let spec = PluginSpecification::builder()
            .name("@test/plugin")
            .description("Test plugin")
            .version("1.0.0")
            .build()
            .unwrap();

        assert_eq!(spec.name, "@test/plugin");
        assert_eq!(spec.description, "Test plugin");
        assert_eq!(spec.version, "1.0.0");
    }

    #[test]
    fn test_plugin_specification_builder_default_version() {
        let spec = PluginSpecification::builder()
            .name("@test/plugin")
            .description("Test plugin")
            .build()
            .unwrap();

        assert_eq!(spec.version, "1.0.0");
    }

    #[test]
    fn test_plugin_specification_builder_missing_name() {
        let result = PluginSpecification::builder()
            .description("Test plugin")
            .build();

        assert!(result.is_err());
    }
}


