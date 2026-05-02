//! HookService - Unified Hook Management Service for Rust
//!
//! This service provides a centralized hook management system that integrates
//! with the Eliza event system. Hooks can be registered for specific event
//! types and will be triggered when those events are emitted.
//!
//! Key Features:
//! - Register hooks for specific event types with priority ordering
//! - FIFO execution order by default, with priority override support
//! - Hook eligibility checks based on requirements (OS, binaries, env vars, config paths)

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::service::service_type;

// ============================================================================
// Hook Types
// ============================================================================

/// Source of a hook registration
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookSource {
    /// Hook bundled with the core system
    Bundled,
    /// Hook from a managed/installed package
    Managed,
    /// Hook from the current workspace
    Workspace,
    /// Hook from a plugin
    Plugin,
    /// Hook registered at runtime
    Runtime,
}

/// Hook-specific event types
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HookEventType {
    /// Triggered when a new command is issued
    HookCommandNew,
    /// Triggered when a command is reset
    HookCommandReset,
    /// Triggered when a command is stopped
    HookCommandStop,
    /// Triggered when a session starts
    HookSessionStart,
    /// Triggered when a session ends
    HookSessionEnd,
    /// Triggered during agent basic_capabilities
    HookAgentBasicCapabilities,
    /// Triggered when an agent starts
    HookAgentStart,
    /// Triggered when an agent ends
    HookAgentEnd,
    /// Triggered when a gateway starts
    HookGatewayStart,
    /// Triggered when a gateway stops
    HookGatewayStop,
    /// Triggered before compaction
    HookCompactionBefore,
    /// Triggered after compaction
    HookCompactionAfter,
    /// Triggered before a tool executes
    HookToolBefore,
    /// Triggered after a tool executes
    HookToolAfter,
    /// Triggered when tool results are persisted
    HookToolPersist,
    /// Triggered when a message is being sent
    HookMessageSending,
}

impl HookEventType {
    /// Get the event type as a string
    pub fn as_str(&self) -> &'static str {
        match self {
            HookEventType::HookCommandNew => "HOOK_COMMAND_NEW",
            HookEventType::HookCommandReset => "HOOK_COMMAND_RESET",
            HookEventType::HookCommandStop => "HOOK_COMMAND_STOP",
            HookEventType::HookSessionStart => "HOOK_SESSION_START",
            HookEventType::HookSessionEnd => "HOOK_SESSION_END",
            HookEventType::HookAgentBasicCapabilities => "HOOK_AGENT_BASIC_CAPABILITIES",
            HookEventType::HookAgentStart => "HOOK_AGENT_START",
            HookEventType::HookAgentEnd => "HOOK_AGENT_END",
            HookEventType::HookGatewayStart => "HOOK_GATEWAY_START",
            HookEventType::HookGatewayStop => "HOOK_GATEWAY_STOP",
            HookEventType::HookCompactionBefore => "HOOK_COMPACTION_BEFORE",
            HookEventType::HookCompactionAfter => "HOOK_COMPACTION_AFTER",
            HookEventType::HookToolBefore => "HOOK_TOOL_BEFORE",
            HookEventType::HookToolAfter => "HOOK_TOOL_AFTER",
            HookEventType::HookToolPersist => "HOOK_TOOL_PERSIST",
            HookEventType::HookMessageSending => "HOOK_MESSAGE_SENDING",
        }
    }

    /// Get all event types
    pub fn all() -> &'static [HookEventType] {
        &[
            HookEventType::HookCommandNew,
            HookEventType::HookCommandReset,
            HookEventType::HookCommandStop,
            HookEventType::HookSessionStart,
            HookEventType::HookSessionEnd,
            HookEventType::HookAgentBasicCapabilities,
            HookEventType::HookAgentStart,
            HookEventType::HookAgentEnd,
            HookEventType::HookGatewayStart,
            HookEventType::HookGatewayStop,
            HookEventType::HookCompactionBefore,
            HookEventType::HookCompactionAfter,
            HookEventType::HookToolBefore,
            HookEventType::HookToolAfter,
            HookEventType::HookToolPersist,
            HookEventType::HookMessageSending,
        ]
    }
}

/// Default hook priority
pub const DEFAULT_HOOK_PRIORITY: i32 = 0;

/// Requirements that must be met for a hook to be eligible
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRequirements {
    /// Required OS platforms (darwin, linux, win32)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<Vec<String>>,
    /// Required binaries (all must be present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bins: Option<Vec<String>>,
    /// Any of these binaries (at least one must be present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub any_bins: Option<Vec<String>>,
    /// Required environment variables
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    /// Required config paths
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Vec<String>>,
}

/// Result of checking hook eligibility
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookEligibilityResult {
    /// Whether the hook is eligible to run
    pub eligible: bool,
    /// Reasons for ineligibility
    #[serde(default)]
    pub reasons: Vec<String>,
}

impl HookEligibilityResult {
    /// Create an eligible result
    pub fn eligible() -> Self {
        Self {
            eligible: true,
            reasons: Vec::new(),
        }
    }

    /// Create an ineligible result with reasons
    pub fn ineligible(reasons: Vec<String>) -> Self {
        Self {
            eligible: false,
            reasons,
        }
    }
}

/// Metadata describing a registered hook
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookMetadata {
    /// Hook name
    pub name: String,
    /// Hook description
    #[serde(default)]
    pub description: String,
    /// Source of the hook
    pub source: HookSource,
    /// Plugin ID if from a plugin
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    /// Events this hook listens to
    pub events: Vec<String>,
    /// Hook priority (higher runs first)
    #[serde(default)]
    pub priority: i32,
    /// Whether the hook is enabled
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Whether hook runs even when globally disabled
    #[serde(default)]
    pub always: bool,
    /// Requirements for hook eligibility
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<HookRequirements>,
}

fn default_enabled() -> bool {
    true
}

/// A registered hook with its handler ID
#[derive(Clone, Debug)]
pub struct HookRegistration {
    /// Unique hook ID
    pub id: String,
    /// Hook metadata
    pub metadata: HookMetadata,
    /// Registration timestamp
    pub registered_at: f64,
}

/// Summary information for a hook
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSummary {
    /// Hook name
    pub name: String,
    /// Events this hook listens to
    pub events: Vec<String>,
    /// Source of the hook
    pub source: HookSource,
    /// Whether the hook is enabled
    pub enabled: bool,
    /// Hook priority
    pub priority: i32,
    /// Plugin ID if from a plugin
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

/// Snapshot of all registered hooks
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSnapshot {
    /// All registered hooks
    pub hooks: Vec<HookSummary>,
    /// Snapshot version
    pub version: u64,
    /// Snapshot timestamp
    pub timestamp: f64,
}

/// Result of loading hooks from a directory
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookLoadResult {
    /// Successfully loaded hooks
    pub loaded: Vec<String>,
    /// Skipped hooks with reasons
    pub skipped: Vec<HookLoadSkipped>,
    /// Errors encountered
    pub errors: Vec<HookLoadError>,
}

/// Information about a skipped hook
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookLoadSkipped {
    /// Hook name
    pub name: String,
    /// Reason for skipping
    pub reason: String,
}

/// Information about a hook load error
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookLoadError {
    /// Hook name
    pub name: String,
    /// Error message
    pub error: String,
}

// ============================================================================
// Legacy Event Mapping
// ============================================================================

/// Map a legacy event string to a HookEventType
pub fn map_legacy_event(legacy: &str) -> Option<HookEventType> {
    match legacy {
        "command:new" => Some(HookEventType::HookCommandNew),
        "command:reset" => Some(HookEventType::HookCommandReset),
        "command:stop" => Some(HookEventType::HookCommandStop),
        "session:start" => Some(HookEventType::HookSessionStart),
        "session:end" => Some(HookEventType::HookSessionEnd),
        "agent:basic_capabilities" => Some(HookEventType::HookAgentBasicCapabilities),
        "agent:start" => Some(HookEventType::HookAgentStart),
        "agent:end" => Some(HookEventType::HookAgentEnd),
        "gateway:start" => Some(HookEventType::HookGatewayStart),
        "gateway:stop" => Some(HookEventType::HookGatewayStop),
        "compaction:before" => Some(HookEventType::HookCompactionBefore),
        "compaction:after" => Some(HookEventType::HookCompactionAfter),
        "tool:before" => Some(HookEventType::HookToolBefore),
        "tool:after" => Some(HookEventType::HookToolAfter),
        "tool:persist" => Some(HookEventType::HookToolPersist),
        "message:sending" => Some(HookEventType::HookMessageSending),
        _ => None,
    }
}

/// Map a list of legacy events to HookEventTypes
pub fn map_legacy_events(legacy_events: &[String]) -> Vec<HookEventType> {
    legacy_events
        .iter()
        .filter_map(|e| map_legacy_event(e))
        .collect()
}

// ============================================================================
// HookService Implementation
// ============================================================================

/// Unified hook management service
///
/// Provides centralized hook registration, discovery, eligibility checking,
/// and dispatch integrated with the Eliza event system.
pub struct HookService {
    registry: HashMap<String, HookRegistration>,
    event_index: HashMap<String, HashSet<String>>,
    id_counter: AtomicU64,
    snapshot_version: AtomicU64,
    config: serde_json::Value,
}

impl Default for HookService {
    fn default() -> Self {
        Self::new()
    }
}

impl HookService {
    /// Create a new HookService
    pub fn new() -> Self {
        Self {
            registry: HashMap::new(),
            event_index: HashMap::new(),
            id_counter: AtomicU64::new(0),
            snapshot_version: AtomicU64::new(0),
            config: serde_json::Value::Null,
        }
    }

    /// Get the service type
    pub fn service_type() -> &'static str {
        service_type::HOOKS
    }

    /// Get the capability description
    pub fn capability_description() -> &'static str {
        "Hook registration and execution"
    }

    /// Register a hook for one or more events
    ///
    /// # Arguments
    /// * `events` - Event type(s) to listen for
    /// * `name` - Name of the hook
    /// * `source` - Source of the hook registration
    /// * `options` - Optional registration parameters
    ///
    /// # Returns
    /// Unique hook ID
    pub fn register(
        &mut self,
        events: Vec<String>,
        name: String,
        source: HookSource,
        options: HookRegistrationOptions,
    ) -> String {
        let id_num = self.id_counter.fetch_add(1, Ordering::SeqCst);
        let hook_id = format!("hook-{}-{:08x}", id_num, rand_u32());

        let metadata = HookMetadata {
            name,
            description: options.description.unwrap_or_default(),
            source,
            plugin_id: options.plugin_id,
            events: events.clone(),
            priority: options.priority.unwrap_or(DEFAULT_HOOK_PRIORITY),
            enabled: true,
            always: options.always.unwrap_or(false),
            requires: options.requires,
        };

        let registration = HookRegistration {
            id: hook_id.clone(),
            metadata,
            registered_at: current_timestamp(),
        };

        self.registry.insert(hook_id.clone(), registration);

        for event in events {
            self.event_index
                .entry(event)
                .or_default()
                .insert(hook_id.clone());
        }

        self.snapshot_version.fetch_add(1, Ordering::SeqCst);
        hook_id
    }

    /// Unregister a hook by ID
    pub fn unregister(&mut self, hook_id: &str) -> bool {
        let registration = match self.registry.remove(hook_id) {
            Some(r) => r,
            None => return false,
        };

        for event in &registration.metadata.events {
            if let Some(hooks) = self.event_index.get_mut(event) {
                hooks.remove(hook_id);
                if hooks.is_empty() {
                    self.event_index.remove(event);
                }
            }
        }

        self.snapshot_version.fetch_add(1, Ordering::SeqCst);
        true
    }

    /// Get a snapshot of all registered hooks
    pub fn get_snapshot(&self) -> HookSnapshot {
        let hooks: Vec<HookSummary> = self
            .registry
            .values()
            .map(|reg| HookSummary {
                name: reg.metadata.name.clone(),
                events: reg.metadata.events.clone(),
                source: reg.metadata.source,
                enabled: reg.metadata.enabled,
                priority: reg.metadata.priority,
                plugin_id: reg.metadata.plugin_id.clone(),
            })
            .collect();

        HookSnapshot {
            hooks,
            version: self.snapshot_version.load(Ordering::SeqCst),
            timestamp: current_timestamp(),
        }
    }

    /// Get all hooks registered for a specific event
    pub fn get_hooks_by_event(&self, event: &str) -> Vec<&HookRegistration> {
        self.event_index
            .get(event)
            .map(|hook_ids| {
                hook_ids
                    .iter()
                    .filter_map(|id| self.registry.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get a specific hook by ID
    pub fn get_hook(&self, hook_id: &str) -> Option<&HookRegistration> {
        self.registry.get(hook_id)
    }

    /// Get all registered hooks
    pub fn get_all_hooks(&self) -> Vec<&HookRegistration> {
        self.registry.values().collect()
    }

    /// Enable or disable a hook
    pub fn set_enabled(&mut self, hook_id: &str, enabled: bool) {
        if let Some(reg) = self.registry.get_mut(hook_id) {
            reg.metadata.enabled = enabled;
            self.snapshot_version.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Update the priority of a hook
    pub fn set_priority(&mut self, hook_id: &str, priority: i32) {
        if let Some(reg) = self.registry.get_mut(hook_id) {
            reg.metadata.priority = priority;
            self.snapshot_version.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Set the configuration for requirement checks
    pub fn set_config(&mut self, config: serde_json::Value) {
        self.config = config;
    }

    /// Check if a hook is eligible to run
    pub fn check_eligibility(&self, hook_id: &str) -> HookEligibilityResult {
        match self.registry.get(hook_id) {
            Some(reg) => match &reg.metadata.requires {
                Some(reqs) => self.check_requirements(reqs, None),
                None => HookEligibilityResult::eligible(),
            },
            None => HookEligibilityResult::ineligible(vec!["Hook not found".to_string()]),
        }
    }

    /// Check if requirements are met
    pub fn check_requirements(
        &self,
        requirements: &HookRequirements,
        config: Option<&serde_json::Value>,
    ) -> HookEligibilityResult {
        let cfg = config.unwrap_or(&self.config);
        let mut reasons = Vec::new();

        // OS check
        if let Some(ref os_list) = requirements.os {
            let current_os = get_current_platform();
            if !os_list.iter().any(|os| os == &current_os) {
                reasons.push(format!(
                    "OS '{}' not in allowed list: {:?}",
                    current_os, os_list
                ));
            }
        }

        // Required binaries check
        if let Some(ref bins) = requirements.bins {
            for bin in bins {
                if !has_binary(bin) {
                    reasons.push(format!("Required binary '{}' not found", bin));
                }
            }
        }

        // Any binaries check
        if let Some(ref any_bins) = requirements.any_bins {
            if !any_bins.iter().any(|b| has_binary(b)) {
                reasons.push(format!(
                    "None of the required binaries found: {:?}",
                    any_bins
                ));
            }
        }

        // Environment variables check
        if let Some(ref env_vars) = requirements.env {
            for env_var in env_vars {
                match env::var(env_var) {
                    Ok(val) if is_truthy(&val) => {}
                    _ => {
                        reasons.push(format!("Required env var '{}' not set or falsy", env_var));
                    }
                }
            }
        }

        // Config path checks
        if let Some(ref config_paths) = requirements.config {
            for config_path in config_paths {
                let value = resolve_config_path(cfg, config_path);
                if !is_truthy_value(&value) {
                    reasons.push(format!(
                        "Required config path '{}' not set or falsy",
                        config_path
                    ));
                }
            }
        }

        if reasons.is_empty() {
            HookEligibilityResult::eligible()
        } else {
            HookEligibilityResult::ineligible(reasons)
        }
    }

    /// Get hooks for an event, sorted by priority (higher first), then FIFO
    pub fn get_sorted_hooks_for_event(&self, event: &str) -> Vec<&HookRegistration> {
        let mut hooks = self.get_hooks_by_event(event);
        hooks.sort_by(|a, b| {
            b.metadata.priority.cmp(&a.metadata.priority).then_with(|| {
                a.registered_at
                    .partial_cmp(&b.registered_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        hooks
    }
}

/// Options for hook registration
#[derive(Clone, Debug, Default)]
pub struct HookRegistrationOptions {
    /// Hook description
    pub description: Option<String>,
    /// Plugin ID if from a plugin
    pub plugin_id: Option<String>,
    /// Hook priority (higher runs first)
    pub priority: Option<i32>,
    /// Whether hook runs even when globally disabled
    pub always: Option<bool>,
    /// Requirements for hook eligibility
    pub requires: Option<HookRequirements>,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn current_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn rand_u32() -> u32 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    SystemTime::now().hash(&mut hasher);
    hasher.finish() as u32
}

fn get_current_platform() -> String {
    #[cfg(target_os = "macos")]
    {
        "darwin".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "linux".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "win32".to_string()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        std::env::consts::OS.to_string()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn has_binary(bin: &str) -> bool {
    which::which(bin).is_ok()
}

#[cfg(target_arch = "wasm32")]
fn has_binary(_bin: &str) -> bool {
    // Binary checks not supported on WASM
    false
}

fn is_truthy(value: &str) -> bool {
    let lower = value.to_lowercase();
    !lower.is_empty() && lower != "0" && lower != "false" && lower != "no" && lower != "off"
}

fn is_truthy_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        serde_json::Value::String(s) => is_truthy(s),
        serde_json::Value::Array(arr) => !arr.is_empty(),
        serde_json::Value::Object(obj) => !obj.is_empty(),
    }
}

fn resolve_config_path(config: &serde_json::Value, path: &str) -> serde_json::Value {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = config;

    for part in parts {
        match current {
            serde_json::Value::Object(obj) => {
                current = obj.get(part).unwrap_or(&serde_json::Value::Null);
            }
            _ => return serde_json::Value::Null,
        }
    }

    current.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hook_event_type_as_str() {
        assert_eq!(HookEventType::HookCommandNew.as_str(), "HOOK_COMMAND_NEW");
        assert_eq!(
            HookEventType::HookAgentBasicCapabilities.as_str(),
            "HOOK_AGENT_BASIC_CAPABILITIES"
        );
    }

    #[test]
    fn test_map_legacy_event() {
        assert_eq!(
            map_legacy_event("command:new"),
            Some(HookEventType::HookCommandNew)
        );
        assert_eq!(
            map_legacy_event("agent:basic_capabilities"),
            Some(HookEventType::HookAgentBasicCapabilities)
        );
        assert_eq!(map_legacy_event("unknown:event"), None);
    }

    #[test]
    fn test_hook_service_register_unregister() {
        let mut service = HookService::new();

        let hook_id = service.register(
            vec!["HOOK_COMMAND_NEW".to_string()],
            "test-hook".to_string(),
            HookSource::Runtime,
            HookRegistrationOptions::default(),
        );

        assert!(service.get_hook(&hook_id).is_some());
        assert_eq!(service.get_hooks_by_event("HOOK_COMMAND_NEW").len(), 1);

        assert!(service.unregister(&hook_id));
        assert!(service.get_hook(&hook_id).is_none());
        assert!(service.get_hooks_by_event("HOOK_COMMAND_NEW").is_empty());
    }

    #[test]
    fn test_hook_service_snapshot() {
        let mut service = HookService::new();

        service.register(
            vec!["HOOK_COMMAND_NEW".to_string()],
            "test-hook".to_string(),
            HookSource::Runtime,
            HookRegistrationOptions::default(),
        );

        let snapshot = service.get_snapshot();
        assert_eq!(snapshot.hooks.len(), 1);
        assert_eq!(snapshot.hooks[0].name, "test-hook");
    }

    #[test]
    fn test_check_requirements_os() {
        let service = HookService::new();
        let requirements = HookRequirements {
            os: Some(vec!["darwin".to_string()]),
            ..Default::default()
        };

        let result = service.check_requirements(&requirements, None);

        #[cfg(target_os = "macos")]
        assert!(result.eligible);

        #[cfg(not(target_os = "macos"))]
        assert!(!result.eligible);
    }

    #[test]
    fn test_is_truthy() {
        assert!(is_truthy("true"));
        assert!(is_truthy("1"));
        assert!(is_truthy("yes"));
        assert!(!is_truthy(""));
        assert!(!is_truthy("false"));
        assert!(!is_truthy("0"));
        assert!(!is_truthy("no"));
        assert!(!is_truthy("off"));
    }
}
