#![allow(missing_docs)]

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::info;

use crate::error::{PluginManagerError, Result};
use crate::types::*;

// ----- Registry constants -----

const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json";
const CACHE_DURATION_MS: i64 = 3_600_000; // 1 hour

const API_SERVICE_URL_DEFAULT: &str = "https://www.dev.elizacloud.ai/api";

// =====================================================================
// PluginManagerService
// =====================================================================

pub struct PluginManagerService {
    config: PluginManagerConfig,
    plugins: RwLock<HashMap<String, PluginState>>,
    original_plugins: HashSet<String>,
    protected_plugins: HashSet<String>,
    component_registry: RwLock<HashMap<String, Vec<ComponentRegistration>>>,
    installed_plugins: RwLock<HashMap<String, DynamicPluginInfo>>,
    registry_cache: RwLock<Option<RegistryCache>>,
    client: Client,
}

struct RegistryCache {
    data: HashMap<String, RegistryEntry>,
    timestamp: i64,
}

impl PluginManagerService {
    pub fn new(config: PluginManagerConfig) -> Self {
        let mut protected = HashSet::new();
        for name in PROTECTED_PLUGINS {
            protected.insert((*name).to_string());
        }

        Self {
            config,
            plugins: RwLock::new(HashMap::new()),
            original_plugins: HashSet::new(),
            protected_plugins: protected,
            component_registry: RwLock::new(HashMap::new()),
            installed_plugins: RwLock::new(HashMap::new()),
            registry_cache: RwLock::new(None),
            client: Client::new(),
        }
    }

    pub fn start(config: PluginManagerConfig) -> Self {
        let service = Self::new(config);
        info!("[PluginManagerService] Initialized");
        service
    }

    // ----- Plugin Registry Methods -----

    pub fn register_plugin(&self, name: &str, id: &str) -> Result<String> {
        let plugins = self.plugins.read().map_err(|e| {
            PluginManagerError::ServiceUnavailable(format!("Lock poisoned: {}", e))
        })?;

        if plugins.contains_key(id) {
            return Err(PluginManagerError::AlreadyRegistered(name.to_string()));
        }

        if self.original_plugins.contains(name) {
            return Err(PluginManagerError::OriginalPlugin(format!(
                "Cannot register a plugin with the same name as an original plugin: {}",
                name
            )));
        }

        if self.is_protected_plugin(name) {
            return Err(PluginManagerError::ProtectedPlugin(name.to_string()));
        }

        drop(plugins);

        let state = PluginState::new(id.to_string(), name.to_string(), PluginStatus::Ready);

        let mut plugins = self.plugins.write().map_err(|e| {
            PluginManagerError::ServiceUnavailable(format!("Lock poisoned: {}", e))
        })?;
        plugins.insert(id.to_string(), state);

        Ok(id.to_string())
    }

    pub fn initialize_with_plugins(&mut self, plugin_names: Vec<String>) {
        for name in &plugin_names {
            self.original_plugins.insert(name.clone());
        }

        let mut plugins = self.plugins.write().expect("Lock poisoned");
        for name in &plugin_names {
            let id = format!("plugin-{}", name);
            let mut state = PluginState::new(id.clone(), name.clone(), PluginStatus::Loaded);
            state.loaded_at = Some(Utc::now().timestamp_millis());
            plugins.insert(id, state);
        }
    }

    pub fn get_plugin(&self, id: &str) -> Option<PluginState> {
        self.plugins
            .read()
            .ok()
            .and_then(|plugins| plugins.get(id).cloned())
    }

    pub fn get_all_plugins(&self) -> Vec<PluginState> {
        self.plugins
            .read()
            .map(|plugins| plugins.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_loaded_plugins(&self) -> Vec<PluginState> {
        self.get_all_plugins()
            .into_iter()
            .filter(|p| p.status == PluginStatus::Loaded)
            .collect()
    }

    pub fn update_plugin_state(&self, id: &str, status: PluginStatus) {
        if let Ok(mut plugins) = self.plugins.write() {
            if let Some(state) = plugins.get_mut(id) {
                state.status = status;
                match status {
                    PluginStatus::Loaded => {
                        state.loaded_at = Some(Utc::now().timestamp_millis());
                        state.error = None;
                    }
                    PluginStatus::Unloaded => {
                        state.unloaded_at = Some(Utc::now().timestamp_millis());
                    }
                    PluginStatus::Error => {}
                    PluginStatus::Ready => {}
                }
            }
        }
    }

    pub fn set_plugin_error(&self, id: &str, error: String) {
        if let Ok(mut plugins) = self.plugins.write() {
            if let Some(state) = plugins.get_mut(id) {
                state.status = PluginStatus::Error;
                state.error = Some(error);
            }
        }
    }

    // ----- Load/Unload -----

    pub fn load_plugin(&self, params: &LoadPluginParams) -> Result<()> {
        let plugins = self.plugins.read().map_err(|e| {
            PluginManagerError::ServiceUnavailable(format!("Lock poisoned: {}", e))
        })?;

        let plugin_state = plugins
            .get(&params.plugin_id)
            .ok_or_else(|| PluginManagerError::NotFound(params.plugin_id.clone()))?;

        if params.force && self.is_protected_plugin(&plugin_state.name) {
            return Err(PluginManagerError::ProtectedPlugin(
                plugin_state.name.clone(),
            ));
        }

        if plugin_state.status == PluginStatus::Loaded && !params.force {
            info!(
                "[PluginManagerService] Plugin {} already loaded",
                plugin_state.name
            );
            return Ok(());
        }

        if plugin_state.status != PluginStatus::Ready
            && plugin_state.status != PluginStatus::Unloaded
            && !params.force
        {
            return Err(PluginManagerError::NotReady {
                name: plugin_state.name.clone(),
                status: plugin_state.status.to_string(),
            });
        }

        let plugin_name = plugin_state.name.clone();
        let plugin_id = params.plugin_id.clone();
        drop(plugins);

        info!("[PluginManagerService] Loading plugin {}...", plugin_name);
        self.update_plugin_state(&plugin_id, PluginStatus::Loaded);
        info!(
            "[PluginManagerService] Plugin {} loaded successfully",
            plugin_name
        );

        Ok(())
    }

    pub fn unload_plugin(&self, params: &UnloadPluginParams) -> Result<()> {
        let plugins = self.plugins.read().map_err(|e| {
            PluginManagerError::ServiceUnavailable(format!("Lock poisoned: {}", e))
        })?;

        let plugin_state = plugins
            .get(&params.plugin_id)
            .ok_or_else(|| PluginManagerError::NotFound(params.plugin_id.clone()))?;

        if plugin_state.status != PluginStatus::Loaded {
            info!(
                "[PluginManagerService] Plugin {} is not loaded",
                plugin_state.name
            );
            return Ok(());
        }

        if self.original_plugins.contains(&plugin_state.name) {
            return Err(PluginManagerError::OriginalPlugin(
                plugin_state.name.clone(),
            ));
        }

        if self.is_protected_plugin(&plugin_state.name) {
            return Err(PluginManagerError::ProtectedPlugin(
                plugin_state.name.clone(),
            ));
        }

        let plugin_name = plugin_state.name.clone();
        let plugin_id = params.plugin_id.clone();
        drop(plugins);

        info!("[PluginManagerService] Unloading plugin {}...", plugin_name);
        self.update_plugin_state(&plugin_id, PluginStatus::Unloaded);
        info!(
            "[PluginManagerService] Plugin {} unloaded successfully",
            plugin_name
        );

        Ok(())
    }

    // ----- Protection Checks -----

    pub fn is_protected_plugin(&self, plugin_name: &str) -> bool {
        if self.protected_plugins.contains(plugin_name) {
            return true;
        }

        let without_prefix = plugin_name.strip_prefix("@elizaos/").unwrap_or(plugin_name);
        if self.protected_plugins.contains(without_prefix) {
            return true;
        }

        let with_prefix = format!("@elizaos/{}", plugin_name);
        if self.protected_plugins.contains(&with_prefix) {
            return true;
        }

        self.original_plugins.contains(plugin_name)
    }

    pub fn can_unload_plugin(&self, plugin_name: &str) -> bool {
        !self.is_protected_plugin(plugin_name)
    }

    pub fn get_protection_reason(&self, plugin_name: &str) -> Option<String> {
        if self.protected_plugins.contains(plugin_name) {
            return Some(format!(
                "{} is a core system plugin and cannot be unloaded",
                plugin_name
            ));
        }

        let without_prefix = plugin_name.strip_prefix("@elizaos/").unwrap_or(plugin_name);
        if self.protected_plugins.contains(without_prefix) {
            return Some(format!(
                "{} is a core system plugin and cannot be unloaded",
                plugin_name
            ));
        }

        let with_prefix = format!("@elizaos/{}", plugin_name);
        if self.protected_plugins.contains(&with_prefix) {
            return Some(format!(
                "{} is a core system plugin and cannot be unloaded",
                plugin_name
            ));
        }

        if self.original_plugins.contains(plugin_name) {
            return Some(format!(
                "{} was loaded at startup and is required for agent operation",
                plugin_name
            ));
        }

        None
    }

    pub fn get_protected_plugins(&self) -> Vec<String> {
        self.protected_plugins.iter().cloned().collect()
    }

    pub fn get_original_plugins(&self) -> Vec<String> {
        self.original_plugins.iter().cloned().collect()
    }

    // ----- Component Tracking -----

    pub fn track_component(
        &self,
        plugin_id: &str,
        component_type: ComponentType,
        component_name: &str,
    ) {
        let registration = ComponentRegistration {
            plugin_id: plugin_id.to_string(),
            component_type,
            component_name: component_name.to_string(),
            timestamp: Utc::now().timestamp_millis(),
        };

        if let Ok(mut registry) = self.component_registry.write() {
            registry
                .entry(plugin_id.to_string())
                .or_default()
                .push(registration);
        }
    }

    pub fn get_component_registrations(&self, plugin_id: &str) -> Vec<ComponentRegistration> {
        self.component_registry
            .read()
            .ok()
            .and_then(|registry| registry.get(plugin_id).cloned())
            .unwrap_or_default()
    }

    // ----- Registry Installation -----

    pub async fn fetch_registry(&self) -> Result<HashMap<String, RegistryEntry>> {
        // Check cache first
        if let Ok(cache) = self.registry_cache.read() {
            if let Some(ref cached) = *cache {
                if Utc::now().timestamp_millis() - cached.timestamp < CACHE_DURATION_MS {
                    return Ok(cached.data.clone());
                }
            }
        }

        let response = self.client.get(REGISTRY_URL).send().await?;

        if !response.status().is_success() {
            return Err(PluginManagerError::RegistryFetchFailed(format!(
                "HTTP {}",
                response.status()
            )));
        }

        let data: HashMap<String, RegistryEntry> = response.json().await?;

        // Update cache
        if let Ok(mut cache) = self.registry_cache.write() {
            *cache = Some(RegistryCache {
                data: data.clone(),
                timestamp: Utc::now().timestamp_millis(),
            });
        }

        Ok(data)
    }

    pub fn reset_registry_cache(&self) {
        if let Ok(mut cache) = self.registry_cache.write() {
            *cache = None;
        }
    }

    pub fn get_installed_plugin_info(&self, plugin_name: &str) -> Option<DynamicPluginInfo> {
        self.installed_plugins
            .read()
            .ok()
            .and_then(|installed| installed.get(plugin_name).cloned())
    }

    pub fn list_installed_plugins(&self) -> Vec<DynamicPluginInfo> {
        self.installed_plugins
            .read()
            .map(|installed| installed.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn record_installed_plugin(&self, name: &str, info: DynamicPluginInfo) {
        if let Ok(mut installed) = self.installed_plugins.write() {
            installed.insert(name.to_string(), info);
        }
    }

    pub async fn stop(&self) {
        info!("[PluginManagerService] Stopping...");
        if let Ok(mut installed) = self.installed_plugins.write() {
            installed.clear();
        }
        if let Ok(mut registry) = self.component_registry.write() {
            registry.clear();
        }
        info!("[PluginManagerService] Stopped");
    }
}

// =====================================================================
// PluginConfigurationService
// =====================================================================

pub struct PluginConfigurationService;

impl PluginConfigurationService {
    pub fn new() -> Self {
        info!("[PluginConfigurationService] Started");
        Self
    }

    /// Check which config keys from a config map are missing.
    /// A key is "missing" if its value is null/empty AND the env var is not set.
    pub fn get_missing_config_keys(
        &self,
        config: &HashMap<String, Option<String>>,
        env_vars: &HashMap<String, String>,
    ) -> Vec<String> {
        let mut missing = Vec::new();
        for (key, default_value) in config {
            let is_empty = default_value
                .as_ref()
                .map(|v| v.is_empty())
                .unwrap_or(true);
            if is_empty && !env_vars.contains_key(key) {
                missing.push(key.clone());
            }
        }
        missing
    }

    /// Get configuration status for a plugin's config map.
    pub fn get_plugin_config_status(
        &self,
        config: &HashMap<String, Option<String>>,
        env_vars: &HashMap<String, String>,
    ) -> PluginConfigStatus {
        let missing_keys = self.get_missing_config_keys(config, env_vars);
        PluginConfigStatus {
            configured: missing_keys.is_empty(),
            total_keys: config.len(),
            missing_keys,
        }
    }
}

impl Default for PluginConfigurationService {
    fn default() -> Self {
        Self::new()
    }
}

// =====================================================================
// PluginRegistryService
// =====================================================================

pub struct PluginRegistryService {
    api_url: String,
    api_key: String,
    client: Client,
}

impl PluginRegistryService {
    pub fn new(api_url: Option<String>, api_key: Option<String>) -> Self {
        Self {
            api_url: api_url.unwrap_or_else(|| API_SERVICE_URL_DEFAULT.to_string()),
            api_key: api_key.unwrap_or_default(),
            client: Client::new(),
        }
    }

    async fn api_fetch<T: serde::de::DeserializeOwned>(
        &self,
        endpoint: &str,
        method: &str,
        body: Option<Value>,
    ) -> Result<Option<T>> {
        let url = format!("{}{}", self.api_url, endpoint);
        let mut request = match method {
            "POST" => self.client.post(&url),
            _ => self.client.get(&url),
        };

        request = request.header("Content-Type", "application/json");
        if !self.api_key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", self.api_key));
        }

        if let Some(body_value) = body {
            request = request.json(&body_value);
        }

        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body_text = response.text().await.unwrap_or_default();
            return Err(PluginManagerError::Api {
                status,
                message: body_text,
            });
        }

        let api_response: Value = response.json().await?;
        if let Some(data) = api_response.get("data") {
            let result: T = serde_json::from_value(data.clone())?;
            Ok(Some(result))
        } else {
            Ok(None)
        }
    }

    pub async fn search_plugins(
        &self,
        query: &str,
    ) -> RegistryResult<Vec<PluginSearchResult>> {
        info!(
            "[PluginRegistryService] Searching for plugins matching: {}",
            query
        );

        match self
            .api_fetch::<Vec<PluginSearchResult>>(
                "/plugins/search",
                "POST",
                Some(json!({ "query": query, "limit": 10 })),
            )
            .await
        {
            Ok(Some(results)) => RegistryResult {
                data: results,
                from_api: true,
                error: None,
            },
            Ok(None) => RegistryResult {
                data: Vec::new(),
                from_api: true,
                error: None,
            },
            Err(e) => {
                let message = e.to_string();
                info!("[PluginRegistryService] Search failed: {}", message);
                RegistryResult {
                    data: Vec::new(),
                    from_api: false,
                    error: Some(message),
                }
            }
        }
    }

    pub async fn get_plugin_details(
        &self,
        name: &str,
    ) -> RegistryResult<Option<PluginMetadata>> {
        info!(
            "[PluginRegistryService] Getting details for plugin: {}",
            name
        );

        let endpoint = format!("/plugins/{}", urlencoding(name));
        match self
            .api_fetch::<PluginMetadata>(&endpoint, "GET", None)
            .await
        {
            Ok(result) => RegistryResult {
                data: result,
                from_api: true,
                error: None,
            },
            Err(e) => {
                let message = e.to_string();
                info!("[PluginRegistryService] Get details failed: {}", message);
                RegistryResult {
                    data: None,
                    from_api: false,
                    error: Some(message),
                }
            }
        }
    }

    pub async fn get_all_plugins(&self) -> RegistryResult<Vec<PluginMetadata>> {
        info!("[PluginRegistryService] Getting all plugins from registry");

        match self
            .api_fetch::<Vec<PluginMetadata>>("/plugins", "GET", None)
            .await
        {
            Ok(Some(results)) => RegistryResult {
                data: results,
                from_api: true,
                error: None,
            },
            Ok(None) => RegistryResult {
                data: Vec::new(),
                from_api: true,
                error: None,
            },
            Err(e) => {
                let message = e.to_string();
                info!(
                    "[PluginRegistryService] Get all plugins failed: {}",
                    message
                );
                RegistryResult {
                    data: Vec::new(),
                    from_api: false,
                    error: Some(message),
                }
            }
        }
    }

    pub async fn clone_plugin(&self, plugin_name: &str) -> CloneResult {
        info!("[PluginRegistryService] Cloning plugin: {}", plugin_name);

        let details_result = self.get_plugin_details(plugin_name).await;
        if !details_result.from_api {
            return CloneResult {
                success: false,
                error: Some(format!(
                    "Cannot reach plugin registry: {}",
                    details_result.error.unwrap_or_default()
                )),
                plugin_name: None,
                local_path: None,
                has_tests: None,
                dependencies: None,
            };
        }

        match details_result.data {
            Some(plugin) if !plugin.repository.is_empty() => {
                let short_name = plugin.name.replace("@elizaos/", "");
                let clone_dir = format!("cloned-plugins/{}", short_name);

                CloneResult {
                    success: true,
                    plugin_name: Some(plugin.name),
                    local_path: Some(clone_dir),
                    has_tests: Some(false),
                    dependencies: Some(HashMap::new()),
                    error: None,
                }
            }
            _ => CloneResult {
                success: false,
                error: Some(format!(
                    "Plugin \"{}\" not found in registry or has no repository",
                    plugin_name
                )),
                plugin_name: None,
                local_path: None,
                has_tests: None,
                dependencies: None,
            },
        }
    }
}

impl Default for PluginRegistryService {
    fn default() -> Self {
        Self::new(None, None)
    }
}

// Simple percent-encoding for URL path segments
fn urlencoding(s: &str) -> String {
    s.replace('%', "%25")
        .replace(' ', "%20")
        .replace('/', "%2F")
        .replace('@', "%40")
}

// =====================================================================
// Tests
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_manager_new() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        assert!(service.get_all_plugins().is_empty());
    }

    #[test]
    fn test_initialize_with_plugins() {
        let mut service = PluginManagerService::new(PluginManagerConfig::default());
        service.initialize_with_plugins(vec![
            "bootstrap".to_string(),
            "test-plugin".to_string(),
        ]);

        let plugins = service.get_all_plugins();
        assert_eq!(plugins.len(), 2);

        let loaded = service.get_loaded_plugins();
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn test_protected_plugin_detection() {
        let service = PluginManagerService::new(PluginManagerConfig::default());

        assert!(service.is_protected_plugin("plugin-manager"));
        assert!(service.is_protected_plugin("bootstrap"));
        assert!(service.is_protected_plugin("@elizaos/plugin-sql"));
        assert!(!service.is_protected_plugin("some-random-plugin"));
    }

    #[test]
    fn test_can_unload_plugin() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        assert!(!service.can_unload_plugin("plugin-manager"));
        assert!(service.can_unload_plugin("my-custom-plugin"));
    }

    #[test]
    fn test_protection_reason() {
        let service = PluginManagerService::new(PluginManagerConfig::default());

        let reason = service.get_protection_reason("bootstrap");
        assert!(reason.is_some());
        assert!(reason.unwrap().contains("core system plugin"));

        let reason = service.get_protection_reason("unprotected-plugin");
        assert!(reason.is_none());
    }

    #[test]
    fn test_register_plugin() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let result = service.register_plugin("my-plugin", "plugin-my-plugin");
        assert!(result.is_ok());

        let plugin = service.get_plugin("plugin-my-plugin");
        assert!(plugin.is_some());
        assert_eq!(plugin.unwrap().status, PluginStatus::Ready);
    }

    #[test]
    fn test_register_protected_plugin_fails() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let result = service.register_plugin("bootstrap", "plugin-bootstrap");
        assert!(result.is_err());
    }

    #[test]
    fn test_register_duplicate_fails() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let _ = service.register_plugin("my-plugin", "plugin-my-plugin");
        let result = service.register_plugin("my-plugin", "plugin-my-plugin");
        assert!(result.is_err());
    }

    #[test]
    fn test_load_plugin() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        service
            .register_plugin("my-plugin", "plugin-my-plugin")
            .unwrap();

        let result = service.load_plugin(&LoadPluginParams {
            plugin_id: "plugin-my-plugin".to_string(),
            force: false,
        });
        assert!(result.is_ok());

        let plugin = service.get_plugin("plugin-my-plugin").unwrap();
        assert_eq!(plugin.status, PluginStatus::Loaded);
    }

    #[test]
    fn test_unload_plugin() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        service
            .register_plugin("my-plugin", "plugin-my-plugin")
            .unwrap();
        service
            .load_plugin(&LoadPluginParams {
                plugin_id: "plugin-my-plugin".to_string(),
                force: false,
            })
            .unwrap();

        let result = service.unload_plugin(&UnloadPluginParams {
            plugin_id: "plugin-my-plugin".to_string(),
        });
        assert!(result.is_ok());

        let plugin = service.get_plugin("plugin-my-plugin").unwrap();
        assert_eq!(plugin.status, PluginStatus::Unloaded);
    }

    #[test]
    fn test_unload_original_plugin_fails() {
        let mut service = PluginManagerService::new(PluginManagerConfig::default());
        service.initialize_with_plugins(vec!["my-original".to_string()]);

        let plugin = service
            .get_all_plugins()
            .into_iter()
            .find(|p| p.name == "my-original")
            .unwrap();

        let result = service.unload_plugin(&UnloadPluginParams {
            plugin_id: plugin.id.clone(),
        });
        assert!(result.is_err());
    }

    #[test]
    fn test_component_tracking() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        service.track_component("plugin-1", ComponentType::Action, "MY_ACTION");
        service.track_component("plugin-1", ComponentType::Provider, "myProvider");

        let registrations = service.get_component_registrations("plugin-1");
        assert_eq!(registrations.len(), 2);
        assert_eq!(registrations[0].component_name, "MY_ACTION");
    }

    #[test]
    fn test_configuration_service() {
        let service = PluginConfigurationService::new();

        let mut config = HashMap::new();
        config.insert("API_KEY".to_string(), None);
        config.insert("API_URL".to_string(), Some("https://example.com".to_string()));

        let env_vars = HashMap::new();

        let status = service.get_plugin_config_status(&config, &env_vars);
        assert!(!status.configured);
        assert_eq!(status.missing_keys, vec!["API_KEY"]);
        assert_eq!(status.total_keys, 2);
    }

    #[test]
    fn test_configuration_service_all_set() {
        let service = PluginConfigurationService::new();

        let mut config = HashMap::new();
        config.insert("API_KEY".to_string(), None);

        let mut env_vars = HashMap::new();
        env_vars.insert("API_KEY".to_string(), "secret".to_string());

        let status = service.get_plugin_config_status(&config, &env_vars);
        assert!(status.configured);
        assert!(status.missing_keys.is_empty());
    }

    #[test]
    fn test_registry_service_default() {
        let service = PluginRegistryService::default();
        assert_eq!(service.api_url, API_SERVICE_URL_DEFAULT);
    }

    #[test]
    fn test_urlencoding() {
        assert_eq!(urlencoding("@elizaos/plugin-test"), "%40elizaos%2Fplugin-test");
        assert_eq!(urlencoding("simple"), "simple");
    }

    #[test]
    fn test_reset_registry_cache() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        service.reset_registry_cache();
        // Should not panic
    }

    #[test]
    fn test_installed_plugins_lifecycle() {
        let service = PluginManagerService::new(PluginManagerConfig::default());

        assert!(service.list_installed_plugins().is_empty());
        assert!(service.get_installed_plugin_info("test").is_none());

        let info = DynamicPluginInfo {
            name: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            status: DynamicPluginStatus::Installed,
            path: "/tmp/test".to_string(),
            required_env_vars: vec![],
            error_details: None,
            installed_at: Utc::now().to_rfc3339(),
            last_activated: None,
        };

        service.record_installed_plugin("test", info);
        assert_eq!(service.list_installed_plugins().len(), 1);
        assert!(service.get_installed_plugin_info("test").is_some());
    }
}
