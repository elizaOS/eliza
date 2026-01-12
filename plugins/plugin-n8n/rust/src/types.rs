#![allow(missing_docs)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::models::JobStatus;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSpecification {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpecification {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_structure: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceSpecification {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub methods: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorSpecification {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentVariableSpec {
    pub name: String,
    pub description: String,
    pub required: bool,
    pub sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSpecification {
    pub name: String,
    pub description: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ActionSpecification>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<ProviderSpecification>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<Vec<ServiceSpecification>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluators: Option<Vec<EvaluatorSpecification>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_variables: Option<Vec<EnvironmentVariableSpec>>,
}

fn default_version() -> String {
    "1.0.0".to_string()
}

impl PluginSpecification {
    pub fn builder() -> PluginSpecificationBuilder {
        PluginSpecificationBuilder::default()
    }
}

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
    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn version(mut self, version: impl Into<String>) -> Self {
        self.version = version.into();
        self
    }

    pub fn action(mut self, action: ActionSpecification) -> Self {
        self.actions.get_or_insert_with(Vec::new).push(action);
        self
    }

    pub fn provider(mut self, provider: ProviderSpecification) -> Self {
        self.providers.get_or_insert_with(Vec::new).push(provider);
        self
    }

    /// Add a service.
    pub fn service(mut self, service: ServiceSpecification) -> Self {
        self.services.get_or_insert_with(Vec::new).push(service);
        self
    }

    pub fn evaluator(mut self, evaluator: EvaluatorSpecification) -> Self {
        self.evaluators.get_or_insert_with(Vec::new).push(evaluator);
        self
    }

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobError {
    pub iteration: u32,
    pub phase: String,
    pub error: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResults {
    pub passed: u32,
    pub failed: u32,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCreationJob {
    pub id: String,
    pub specification: PluginSpecification,
    pub status: JobStatus,
    pub current_phase: String,
    pub progress: f64,
    pub logs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub output_path: String,
    pub started_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    pub current_iteration: u32,
    pub max_iterations: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_results: Option<TestResults>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_score: Option<f64>,
    pub errors: Vec<JobError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_used: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePluginOptions {
    #[serde(default = "default_use_template")]
    pub use_template: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn default_use_template() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<JobStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_used: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryData {
    pub total_created: usize,
    pub plugins: Vec<PluginInfo>,
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
