//! Plugin Manager types — Rust port of the TypeScript plugin-plugin-manager types.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ============================================================================
// Plugin Status
// ============================================================================

/// Status of a managed plugin.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginStatus {
    Ready,
    Loaded,
    Error,
    Unloaded,
}

// ============================================================================
// Plugin Components
// ============================================================================

/// Tracked components registered by a plugin.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponents {
    pub actions: HashSet<String>,
    pub providers: HashSet<String>,
    pub evaluators: HashSet<String>,
    pub services: HashSet<String>,
    pub event_handlers: HashMap<String, Vec<String>>,
}

/// Registration record for a single component.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRegistration {
    pub plugin_id: String,
    pub component_type: ComponentType,
    pub component_name: String,
    pub timestamp: i64,
}

/// Component type discriminator.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComponentType {
    Action,
    Provider,
    Evaluator,
    Service,
    EventHandler,
}

// ============================================================================
// Plugin State
// ============================================================================

/// Runtime state of a managed plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub id: String,
    pub name: String,
    pub status: PluginStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loaded_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unloaded_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub components: Option<PluginComponents>,
}

// ============================================================================
// Plugin Metadata
// ============================================================================

/// Metadata about a plugin from the registry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMetadata {
    pub name: String,
    pub description: String,
    pub author: String,
    pub repository: String,
    pub versions: Vec<String>,
    pub latest_version: String,
    pub runtime_version: String,
    pub maintainer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
}

// ============================================================================
// Plugin Manager Config
// ============================================================================

/// Configuration for the plugin manager.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManagerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_directory: Option<String>,
}

// ============================================================================
// Load/Unload Parameters
// ============================================================================

/// Parameters for loading a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadPluginParams {
    pub plugin_id: String,
    #[serde(default)]
    pub force: bool,
}

/// Parameters for unloading a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnloadPluginParams {
    pub plugin_id: String,
    #[serde(default)]
    pub force: bool,
}

// ============================================================================
// Install Progress
// ============================================================================

/// Phase of plugin installation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallPhase {
    FetchingRegistry,
    Resolving,
    Downloading,
    Extracting,
    InstallingDeps,
    Validating,
    Configuring,
    Restarting,
    Complete,
    Error,
}

/// Progress update during plugin installation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub phase: InstallPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
    pub message: String,
}

// ============================================================================
// Operation Results
// ============================================================================

/// Result of installing a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub success: bool,
    pub plugin_name: String,
    pub version: String,
    pub install_path: String,
    pub requires_restart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of uninstalling a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub success: bool,
    pub plugin_name: String,
    pub requires_restart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Eject / Sync / Reinject Types
// ============================================================================

/// Upstream metadata for ejected plugins.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamMetadata {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub source: String,
    pub git_url: String,
    pub branch: String,
    pub commit_hash: String,
    pub ejected_at: String,
    pub npm_package: String,
    pub npm_version: String,
    pub last_sync_at: Option<String>,
    pub local_commits: u32,
}

/// Info about an ejected plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EjectedPluginInfo {
    pub name: String,
    pub path: String,
    pub version: String,
    pub upstream: Option<UpstreamMetadata>,
}

/// Result of ejecting a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EjectResult {
    pub success: bool,
    pub plugin_name: String,
    pub ejected_path: String,
    pub upstream_commit: String,
    pub requires_restart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of syncing an ejected plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub success: bool,
    pub plugin_name: String,
    pub ejected_path: String,
    pub upstream_commits: u32,
    pub local_changes: bool,
    pub conflicts: Vec<String>,
    pub commit_hash: String,
    pub requires_restart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of reinjecting a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReinjectResult {
    pub success: bool,
    pub plugin_name: String,
    pub removed_path: String,
    pub requires_restart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
