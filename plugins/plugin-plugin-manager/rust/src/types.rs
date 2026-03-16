#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ----- Service Type Constants -----

pub const SERVICE_TYPE_PLUGIN_MANAGER: &str = "plugin_manager";
pub const SERVICE_TYPE_PLUGIN_CONFIGURATION: &str = "plugin_configuration";
pub const SERVICE_TYPE_REGISTRY: &str = "registry";

// ----- Plugin Status -----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginStatus {
    Ready,
    Loaded,
    Error,
    Unloaded,
}

impl std::fmt::Display for PluginStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginStatus::Ready => write!(f, "ready"),
            PluginStatus::Loaded => write!(f, "loaded"),
            PluginStatus::Error => write!(f, "error"),
            PluginStatus::Unloaded => write!(f, "unloaded"),
        }
    }
}

// ----- Plugin Components -----

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginComponents {
    pub actions: HashSet<String>,
    pub providers: HashSet<String>,
    pub evaluators: HashSet<String>,
    pub services: HashSet<String>,
    pub event_handlers: HashMap<String, HashSet<String>>,
}

// ----- Component Registration -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentRegistration {
    pub plugin_id: String,
    pub component_type: ComponentType,
    pub component_name: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentType {
    Action,
    Provider,
    Evaluator,
    Service,
    EventHandler,
}

impl std::fmt::Display for ComponentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ComponentType::Action => write!(f, "action"),
            ComponentType::Provider => write!(f, "provider"),
            ComponentType::Evaluator => write!(f, "evaluator"),
            ComponentType::Service => write!(f, "service"),
            ComponentType::EventHandler => write!(f, "eventHandler"),
        }
    }
}

// ----- Plugin State -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginState {
    pub id: String,
    pub name: String,
    pub status: PluginStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unloaded_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<PluginComponents>,
}

impl PluginState {
    pub fn new(id: String, name: String, status: PluginStatus) -> Self {
        Self {
            id,
            name,
            status,
            error: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            loaded_at: None,
            unloaded_at: None,
            version: None,
            components: Some(PluginComponents::default()),
        }
    }
}

// ----- Load/Unload Params -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadPluginParams {
    pub plugin_id: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnloadPluginParams {
    pub plugin_id: String,
}

// ----- Plugin Manager Config -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManagerConfig {
    #[serde(default = "default_plugin_directory")]
    pub plugin_directory: String,
}

fn default_plugin_directory() -> String {
    "./plugins".to_string()
}

impl Default for PluginManagerConfig {
    fn default() -> Self {
        Self {
            plugin_directory: default_plugin_directory(),
        }
    }
}

// ----- Install Progress -----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallPhase {
    FetchingRegistry,
    Downloading,
    Extracting,
    InstallingDeps,
    Validating,
    Complete,
}

impl std::fmt::Display for InstallPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallPhase::FetchingRegistry => write!(f, "fetching-registry"),
            InstallPhase::Downloading => write!(f, "downloading"),
            InstallPhase::Extracting => write!(f, "extracting"),
            InstallPhase::InstallingDeps => write!(f, "installing-deps"),
            InstallPhase::Validating => write!(f, "validating"),
            InstallPhase::Complete => write!(f, "complete"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallProgress {
    pub phase: InstallPhase,
    pub message: String,
}

// ----- Plugin Metadata -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMetadata {
    pub name: String,
    pub description: String,
    pub author: String,
    pub repository: String,
    pub versions: Vec<String>,
    pub latest_version: String,
    pub runtime_version: String,
    pub maintainer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
}

// ----- Dynamic Plugin Info -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicPluginInfo {
    pub name: String,
    pub version: String,
    pub status: DynamicPluginStatus,
    pub path: String,
    pub required_env_vars: Vec<EnvVarRequirement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<String>,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activated: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicPluginStatus {
    Installed,
    Loaded,
    Active,
    Inactive,
    Error,
    NeedsConfiguration,
}

impl std::fmt::Display for DynamicPluginStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DynamicPluginStatus::Installed => write!(f, "installed"),
            DynamicPluginStatus::Loaded => write!(f, "loaded"),
            DynamicPluginStatus::Active => write!(f, "active"),
            DynamicPluginStatus::Inactive => write!(f, "inactive"),
            DynamicPluginStatus::Error => write!(f, "error"),
            DynamicPluginStatus::NeedsConfiguration => write!(f, "needs_configuration"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarRequirement {
    pub name: String,
    pub description: String,
    pub sensitive: bool,
    pub is_set: bool,
}

// ----- Registry Entry -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub repository: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npm: Option<NpmInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<GitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpmInfo {
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v1: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v1: Option<GitVersionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitVersionInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

// ----- Plugin Search Result (from API) -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSearchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_config: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npm_package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relevant_section: Option<String>,
}

// ----- Clone Result -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloneResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_tests: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<HashMap<String, String>>,
}

// ----- Registry Result -----

#[derive(Debug, Clone)]
pub struct RegistryResult<T> {
    pub data: T,
    pub from_api: bool,
    pub error: Option<String>,
}

// ----- Plugin Config Status -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfigStatus {
    pub configured: bool,
    pub missing_keys: Vec<String>,
    pub total_keys: usize,
}

// ----- Action/Provider Results -----

#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub text: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: None,
        }
    }

    pub fn success_with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: Some(data),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: false,
            data: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<serde_json::Value>,
}

impl ProviderResult {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            data: None,
            values: None,
        }
    }

    pub fn with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            data: Some(data),
            values: None,
        }
    }

    pub fn with_all(
        text: impl Into<String>,
        data: serde_json::Value,
        values: serde_json::Value,
    ) -> Self {
        Self {
            text: text.into(),
            data: Some(data),
            values: Some(values),
        }
    }
}

// ----- Protected Plugins -----

pub const PROTECTED_PLUGINS: &[&str] = &[
    "plugin-manager",
    "@elizaos/plugin-sql",
    "bootstrap",
    "game-api",
    "inference",
    "autonomy",
    "knowledge",
    "@elizaos/plugin-personality",
    "experience",
    "goals",
    "todo",
];
