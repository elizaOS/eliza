use elizaos_plugin_plugin_manager::error::PluginManagerError;
use elizaos_plugin_plugin_manager::service::{
    PluginConfigurationService, PluginManagerService, PluginRegistryService,
};
use elizaos_plugin_plugin_manager::types::*;
use elizaos_plugin_plugin_manager::PLUGIN;
use serde_json::json;
use std::collections::HashMap;

// =====================================================================
// Plugin Metadata Tests
// =====================================================================

#[test]
fn test_plugin_metadata() {
    assert_eq!(PLUGIN.name, "@elizaos/plugin-plugin-manager-rs");
    assert!(!PLUGIN.description.is_empty());
}

#[test]
fn test_plugin_actions_list() {
    let actions = elizaos_plugin_plugin_manager::PluginManagerPlugin::actions();
    assert_eq!(actions.len(), 7);
    assert!(actions.contains(&"LOAD_PLUGIN"));
    assert!(actions.contains(&"UNLOAD_PLUGIN"));
    assert!(actions.contains(&"INSTALL_PLUGIN_FROM_REGISTRY"));
    assert!(actions.contains(&"SEARCH_PLUGINS"));
    assert!(actions.contains(&"GET_PLUGIN_DETAILS"));
    assert!(actions.contains(&"CLONE_PLUGIN"));
    assert!(actions.contains(&"PUBLISH_PLUGIN"));
}

#[test]
fn test_plugin_providers_list() {
    let providers = elizaos_plugin_plugin_manager::PluginManagerPlugin::providers();
    assert_eq!(providers.len(), 3);
    assert!(providers.contains(&"pluginState"));
    assert!(providers.contains(&"pluginConfigurationStatus"));
    assert!(providers.contains(&"registryPlugins"));
}

// =====================================================================
// Type Serialization Tests
// =====================================================================

#[test]
fn test_plugin_status_serialization() {
    let status = PluginStatus::Loaded;
    let json_str = serde_json::to_string(&status).unwrap();
    assert_eq!(json_str, "\"loaded\"");

    let status = PluginStatus::Ready;
    let json_str = serde_json::to_string(&status).unwrap();
    assert_eq!(json_str, "\"ready\"");

    let status = PluginStatus::Error;
    let json_str = serde_json::to_string(&status).unwrap();
    assert_eq!(json_str, "\"error\"");

    let status = PluginStatus::Unloaded;
    let json_str = serde_json::to_string(&status).unwrap();
    assert_eq!(json_str, "\"unloaded\"");
}

#[test]
fn test_plugin_status_deserialization() {
    let status: PluginStatus = serde_json::from_str("\"loaded\"").unwrap();
    assert_eq!(status, PluginStatus::Loaded);

    let status: PluginStatus = serde_json::from_str("\"ready\"").unwrap();
    assert_eq!(status, PluginStatus::Ready);
}

#[test]
fn test_plugin_status_display() {
    assert_eq!(PluginStatus::Ready.to_string(), "ready");
    assert_eq!(PluginStatus::Loaded.to_string(), "loaded");
    assert_eq!(PluginStatus::Error.to_string(), "error");
    assert_eq!(PluginStatus::Unloaded.to_string(), "unloaded");
}

#[test]
fn test_plugin_state_creation() {
    let state = PluginState::new(
        "test-id".to_string(),
        "test-plugin".to_string(),
        PluginStatus::Ready,
    );

    assert_eq!(state.id, "test-id");
    assert_eq!(state.name, "test-plugin");
    assert_eq!(state.status, PluginStatus::Ready);
    assert!(state.error.is_none());
    assert!(state.loaded_at.is_none());
    assert!(state.unloaded_at.is_none());
    assert!(state.components.is_some());
}

#[test]
fn test_plugin_state_serialization() {
    let state = PluginState::new(
        "test-id".to_string(),
        "test-plugin".to_string(),
        PluginStatus::Loaded,
    );

    let json_value = serde_json::to_value(&state).unwrap();
    assert_eq!(json_value["id"], "test-id");
    assert_eq!(json_value["name"], "test-plugin");
    assert_eq!(json_value["status"], "loaded");
}

#[test]
fn test_component_type_display() {
    assert_eq!(ComponentType::Action.to_string(), "action");
    assert_eq!(ComponentType::Provider.to_string(), "provider");
    assert_eq!(ComponentType::Evaluator.to_string(), "evaluator");
    assert_eq!(ComponentType::Service.to_string(), "service");
    assert_eq!(ComponentType::EventHandler.to_string(), "eventHandler");
}

#[test]
fn test_install_phase_display() {
    assert_eq!(InstallPhase::FetchingRegistry.to_string(), "fetching-registry");
    assert_eq!(InstallPhase::Downloading.to_string(), "downloading");
    assert_eq!(InstallPhase::Extracting.to_string(), "extracting");
    assert_eq!(InstallPhase::InstallingDeps.to_string(), "installing-deps");
    assert_eq!(InstallPhase::Validating.to_string(), "validating");
    assert_eq!(InstallPhase::Complete.to_string(), "complete");
}

#[test]
fn test_dynamic_plugin_status_display() {
    assert_eq!(DynamicPluginStatus::Installed.to_string(), "installed");
    assert_eq!(DynamicPluginStatus::Loaded.to_string(), "loaded");
    assert_eq!(DynamicPluginStatus::NeedsConfiguration.to_string(), "needs_configuration");
}

#[test]
fn test_plugin_metadata_serialization() {
    let metadata = PluginMetadata {
        name: "@elizaos/plugin-test".to_string(),
        description: "A test plugin".to_string(),
        author: "Test Author".to_string(),
        repository: "https://github.com/test/plugin".to_string(),
        versions: vec!["1.0.0".to_string(), "1.1.0".to_string()],
        latest_version: "1.1.0".to_string(),
        runtime_version: "2.0.0".to_string(),
        maintainer: "Test Maintainer".to_string(),
        tags: Some(vec!["test".to_string(), "example".to_string()]),
        categories: None,
    };

    let json_value = serde_json::to_value(&metadata).unwrap();
    assert_eq!(json_value["name"], "@elizaos/plugin-test");
    assert_eq!(json_value["latest_version"], "1.1.0");
    assert!(json_value.get("categories").is_none());
}

#[test]
fn test_action_result_variants() {
    let success = ActionResult::success("It worked");
    assert!(success.success);
    assert_eq!(success.text, "It worked");
    assert!(success.data.is_none());

    let with_data = ActionResult::success_with_data("Done", json!({ "key": "value" }));
    assert!(with_data.success);
    assert!(with_data.data.is_some());
    assert_eq!(with_data.data.unwrap()["key"], "value");

    let error = ActionResult::error("Something failed");
    assert!(!error.success);
    assert_eq!(error.text, "Something failed");
}

#[test]
fn test_provider_result_variants() {
    let simple = ProviderResult::new("Some text");
    assert_eq!(simple.text, "Some text");
    assert!(simple.data.is_none());

    let with_data = ProviderResult::with_data("Result", json!({ "count": 5 }));
    assert_eq!(with_data.text, "Result");
    assert!(with_data.data.is_some());

    let full = ProviderResult::with_all(
        "Full result",
        json!({ "plugins": [] }),
        json!({ "total": 0 }),
    );
    assert!(full.data.is_some());
    assert!(full.values.is_some());
}

#[test]
fn test_plugin_manager_config_default() {
    let config = PluginManagerConfig::default();
    assert_eq!(config.plugin_directory, "./plugins");
}

#[test]
fn test_load_plugin_params_serialization() {
    let params = LoadPluginParams {
        plugin_id: "my-plugin-id".to_string(),
        force: true,
    };

    let json_value = serde_json::to_value(&params).unwrap();
    assert_eq!(json_value["plugin_id"], "my-plugin-id");
    assert_eq!(json_value["force"], true);
}

#[test]
fn test_registry_entry_deserialization() {
    let json_str = r#"{
        "name": "test-plugin",
        "description": "A test",
        "repository": "https://github.com/test",
        "npm": { "repo": "test-plugin", "v1": "1.0.0" },
        "git": null
    }"#;

    let entry: RegistryEntry = serde_json::from_str(json_str).unwrap();
    assert_eq!(entry.name, "test-plugin");
    assert!(entry.npm.is_some());
    assert_eq!(entry.npm.unwrap().repo, "test-plugin");
}

#[test]
fn test_plugin_search_result_deserialization() {
    let json_str = r#"{
        "name": "@elizaos/plugin-solana",
        "description": "Solana blockchain integration",
        "score": 0.87,
        "tags": ["blockchain", "solana"]
    }"#;

    let result: PluginSearchResult = serde_json::from_str(json_str).unwrap();
    assert_eq!(result.name, "@elizaos/plugin-solana");
    assert_eq!(result.score, Some(0.87));
    assert!(result.tags.is_some());
}

#[test]
fn test_clone_result_success() {
    let result = CloneResult {
        success: true,
        error: None,
        plugin_name: Some("@elizaos/plugin-weather".to_string()),
        local_path: Some("./cloned-plugins/plugin-weather".to_string()),
        has_tests: Some(true),
        dependencies: Some(HashMap::new()),
    };

    assert!(result.success);
    assert!(result.error.is_none());
    assert_eq!(result.plugin_name.unwrap(), "@elizaos/plugin-weather");
}

#[test]
fn test_clone_result_failure() {
    let result = CloneResult {
        success: false,
        error: Some("Network error".to_string()),
        plugin_name: None,
        local_path: None,
        has_tests: None,
        dependencies: None,
    };

    assert!(!result.success);
    assert_eq!(result.error.unwrap(), "Network error");
}

#[test]
fn test_env_var_requirement() {
    let req = EnvVarRequirement {
        name: "API_KEY".to_string(),
        description: "The API key for authentication".to_string(),
        sensitive: true,
        is_set: false,
    };

    let json_value = serde_json::to_value(&req).unwrap();
    assert_eq!(json_value["name"], "API_KEY");
    assert_eq!(json_value["sensitive"], true);
    assert_eq!(json_value["is_set"], false);
}

// =====================================================================
// Configuration Service Tests
// =====================================================================

#[test]
fn test_config_service_empty_config() {
    let service = PluginConfigurationService::new();
    let config = HashMap::new();
    let env_vars = HashMap::new();

    let status = service.get_plugin_config_status(&config, &env_vars);
    assert!(status.configured);
    assert_eq!(status.total_keys, 0);
    assert!(status.missing_keys.is_empty());
}

#[test]
fn test_config_service_all_configured_via_defaults() {
    let service = PluginConfigurationService::new();
    let mut config = HashMap::new();
    config.insert("URL".to_string(), Some("https://example.com".to_string()));

    let env_vars = HashMap::new();

    let status = service.get_plugin_config_status(&config, &env_vars);
    assert!(status.configured);
    assert_eq!(status.total_keys, 1);
}

#[test]
fn test_config_service_missing_keys() {
    let service = PluginConfigurationService::new();
    let mut config = HashMap::new();
    config.insert("API_KEY".to_string(), None);
    config.insert("API_SECRET".to_string(), Some(String::new()));
    config.insert("API_URL".to_string(), Some("https://api.example.com".to_string()));

    let env_vars = HashMap::new();

    let missing = service.get_missing_config_keys(&config, &env_vars);
    assert_eq!(missing.len(), 2);
    assert!(missing.contains(&"API_KEY".to_string()));
    assert!(missing.contains(&"API_SECRET".to_string()));
}

#[test]
fn test_config_service_env_vars_override() {
    let service = PluginConfigurationService::new();
    let mut config = HashMap::new();
    config.insert("API_KEY".to_string(), None);
    config.insert("API_SECRET".to_string(), None);

    let mut env_vars = HashMap::new();
    env_vars.insert("API_KEY".to_string(), "my-key".to_string());

    let status = service.get_plugin_config_status(&config, &env_vars);
    assert!(!status.configured);
    assert_eq!(status.missing_keys.len(), 1);
    assert!(status.missing_keys.contains(&"API_SECRET".to_string()));
}

// =====================================================================
// Plugin Manager Service Tests
// =====================================================================

#[test]
fn test_plugin_manager_full_lifecycle() {
    let service = PluginManagerService::new(PluginManagerConfig::default());

    // Register
    let plugin_id = service.register_plugin("dynamic-plugin", "plugin-dynamic").unwrap();
    assert_eq!(plugin_id, "plugin-dynamic");

    // Verify status
    let state = service.get_plugin("plugin-dynamic").unwrap();
    assert_eq!(state.status, PluginStatus::Ready);

    // Load
    service
        .load_plugin(&LoadPluginParams {
            plugin_id: "plugin-dynamic".to_string(),
            force: false,
        })
        .unwrap();

    let state = service.get_plugin("plugin-dynamic").unwrap();
    assert_eq!(state.status, PluginStatus::Loaded);
    assert!(state.loaded_at.is_some());

    // Unload
    service
        .unload_plugin(&UnloadPluginParams {
            plugin_id: "plugin-dynamic".to_string(),
        })
        .unwrap();

    let state = service.get_plugin("plugin-dynamic").unwrap();
    assert_eq!(state.status, PluginStatus::Unloaded);
    assert!(state.unloaded_at.is_some());

    // Reload
    service
        .load_plugin(&LoadPluginParams {
            plugin_id: "plugin-dynamic".to_string(),
            force: false,
        })
        .unwrap();

    let state = service.get_plugin("plugin-dynamic").unwrap();
    assert_eq!(state.status, PluginStatus::Loaded);
}

#[test]
fn test_plugin_manager_protection_variants() {
    let service = PluginManagerService::new(PluginManagerConfig::default());

    // Direct name
    assert!(service.is_protected_plugin("bootstrap"));

    // With @elizaos prefix
    assert!(service.is_protected_plugin("@elizaos/plugin-sql"));

    // Without prefix matching with-prefix entry
    assert!(service.is_protected_plugin("plugin-sql"));

    // Non-protected
    assert!(!service.is_protected_plugin("my-awesome-plugin"));
}

#[test]
fn test_plugin_manager_load_nonexistent() {
    let service = PluginManagerService::new(PluginManagerConfig::default());

    let result = service.load_plugin(&LoadPluginParams {
        plugin_id: "nonexistent".to_string(),
        force: false,
    });

    assert!(result.is_err());
    match result.unwrap_err() {
        PluginManagerError::NotFound(id) => assert_eq!(id, "nonexistent"),
        other => panic!("Expected NotFound error, got: {:?}", other),
    }
}

#[test]
fn test_plugin_manager_load_already_loaded_noop() {
    let service = PluginManagerService::new(PluginManagerConfig::default());
    service
        .register_plugin("test-plugin", "plugin-test")
        .unwrap();
    service
        .load_plugin(&LoadPluginParams {
            plugin_id: "plugin-test".to_string(),
            force: false,
        })
        .unwrap();

    // Loading again should be a no-op (no error)
    let result = service.load_plugin(&LoadPluginParams {
        plugin_id: "plugin-test".to_string(),
        force: false,
    });
    assert!(result.is_ok());
}

#[test]
fn test_plugin_manager_error_state() {
    let service = PluginManagerService::new(PluginManagerConfig::default());
    service
        .register_plugin("broken-plugin", "plugin-broken")
        .unwrap();

    service.set_plugin_error("plugin-broken", "Something went wrong".to_string());

    let state = service.get_plugin("plugin-broken").unwrap();
    assert_eq!(state.status, PluginStatus::Error);
    assert_eq!(state.error.unwrap(), "Something went wrong");

    // Cannot load plugin in error state without force
    let result = service.load_plugin(&LoadPluginParams {
        plugin_id: "plugin-broken".to_string(),
        force: false,
    });
    assert!(result.is_err());
}

#[test]
fn test_component_registration_tracking() {
    let service = PluginManagerService::new(PluginManagerConfig::default());

    service.track_component("plugin-a", ComponentType::Action, "DO_SOMETHING");
    service.track_component("plugin-a", ComponentType::Provider, "someProvider");
    service.track_component("plugin-a", ComponentType::Service, "someService");
    service.track_component("plugin-b", ComponentType::Action, "OTHER_ACTION");

    let a_regs = service.get_component_registrations("plugin-a");
    assert_eq!(a_regs.len(), 3);
    assert_eq!(a_regs[0].component_type, ComponentType::Action);
    assert_eq!(a_regs[1].component_type, ComponentType::Provider);

    let b_regs = service.get_component_registrations("plugin-b");
    assert_eq!(b_regs.len(), 1);

    let c_regs = service.get_component_registrations("plugin-c");
    assert!(c_regs.is_empty());
}

#[test]
fn test_protected_plugins_constant() {
    assert!(PROTECTED_PLUGINS.contains(&"plugin-manager"));
    assert!(PROTECTED_PLUGINS.contains(&"bootstrap"));
    assert!(PROTECTED_PLUGINS.contains(&"@elizaos/plugin-sql"));
    assert!(PROTECTED_PLUGINS.contains(&"inference"));
    assert!(!PROTECTED_PLUGINS.contains(&"my-custom-plugin"));
}

#[test]
fn test_service_type_constants() {
    assert_eq!(SERVICE_TYPE_PLUGIN_MANAGER, "plugin_manager");
    assert_eq!(SERVICE_TYPE_PLUGIN_CONFIGURATION, "plugin_configuration");
    assert_eq!(SERVICE_TYPE_REGISTRY, "registry");
}

#[test]
fn test_registry_service_creation() {
    let service = PluginRegistryService::new(
        Some("https://custom.api.com".to_string()),
        Some("my-api-key".to_string()),
    );
    // Service created without error - custom URL/key accepted
    drop(service);

    let default_service = PluginRegistryService::default();
    drop(default_service);
}

// =====================================================================
// Provider Integration Tests
// =====================================================================

#[tokio::test]
async fn test_plugin_state_provider_integration() {
    let mut service = PluginManagerService::new(PluginManagerConfig::default());
    service.initialize_with_plugins(vec![
        "plugin-a".to_string(),
        "plugin-b".to_string(),
    ]);

    // Register and load a dynamic plugin
    service.register_plugin("dynamic-c", "plugin-dynamic-c").unwrap();

    let result = elizaos_plugin_plugin_manager::providers::get_plugin_state(&service).await;
    assert!(result.is_ok());
    let pr = result.unwrap();

    // Should show loaded plugins and ready plugins
    assert!(pr.text.contains("plugin-a"));
    assert!(pr.text.contains("plugin-b"));
    assert!(pr.text.contains("dynamic-c"));
    assert!(pr.text.contains("Loaded Plugins"));
    assert!(pr.text.contains("Ready to Load"));
}

#[test]
fn test_config_status_provider_integration() {
    let mut plugin_manager = PluginManagerService::new(PluginManagerConfig::default());
    plugin_manager.initialize_with_plugins(vec![
        "plugin-with-config".to_string(),
        "plugin-no-config".to_string(),
    ]);

    let config_service = PluginConfigurationService::new();

    let mut config = HashMap::new();
    config.insert("SECRET_KEY".to_string(), None);
    config.insert("PUBLIC_URL".to_string(), Some("https://example.com".to_string()));

    let mut env_vars = HashMap::new();
    env_vars.insert("OTHER_VAR".to_string(), "val".to_string());

    let result = elizaos_plugin_plugin_manager::providers::get_plugin_configuration_status(
        &plugin_manager,
        &config_service,
        &[("plugin-with-config", &config)],
        &env_vars,
    );

    assert!(result.text.contains("Plugin Configuration Status"));
    assert!(result.text.contains("Needs config: 1"));
    assert!(result.text.contains("SECRET_KEY"));
}

// =====================================================================
// Action Integration Tests
// =====================================================================

#[tokio::test]
async fn test_load_action_integration() {
    let service = PluginManagerService::new(PluginManagerConfig::default());
    service.register_plugin("my-plugin", "plugin-my").unwrap();

    let result = elizaos_plugin_plugin_manager::actions::load_plugin(
        &service,
        json!({ "text": "load my-plugin" }),
    )
    .await;

    assert!(result.is_ok());
    let ar = result.unwrap();
    assert!(ar.success);
    assert!(ar.text.contains("Successfully loaded"));

    // Verify state changed
    let state = service.get_plugin("plugin-my").unwrap();
    assert_eq!(state.status, PluginStatus::Loaded);
}

#[tokio::test]
async fn test_unload_action_integration() {
    let service = PluginManagerService::new(PluginManagerConfig::default());
    service.register_plugin("removable", "plugin-removable").unwrap();
    service
        .load_plugin(&LoadPluginParams {
            plugin_id: "plugin-removable".to_string(),
            force: false,
        })
        .unwrap();

    let result = elizaos_plugin_plugin_manager::actions::unload_plugin(
        &service,
        json!({ "text": "unload removable" }),
    )
    .await;

    assert!(result.is_ok());
    let ar = result.unwrap();
    assert!(ar.success);
    assert!(ar.text.contains("Successfully unloaded"));
}

#[tokio::test]
async fn test_publish_action_disabled() {
    let service = PluginManagerService::new(PluginManagerConfig::default());
    let result = elizaos_plugin_plugin_manager::actions::publish_plugin(
        &service,
        json!({ "text": "publish my-plugin" }),
    )
    .await;

    assert!(result.is_ok());
    let ar = result.unwrap();
    assert!(ar.text.contains("temporarily unavailable"));
}
