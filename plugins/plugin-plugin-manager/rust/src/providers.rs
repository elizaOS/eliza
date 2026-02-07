#![allow(missing_docs)]

use serde_json::json;

use crate::error::Result;
use crate::service::{PluginConfigurationService, PluginManagerService, PluginRegistryService};
use crate::types::*;

// =====================================================================
// pluginState provider
// =====================================================================

pub async fn get_plugin_state(service: &PluginManagerService) -> Result<ProviderResult> {
    let plugins = service.get_all_plugins();

    let loaded_plugins: Vec<&PluginState> = plugins
        .iter()
        .filter(|p| p.status == PluginStatus::Loaded)
        .collect();
    let error_plugins: Vec<&PluginState> = plugins
        .iter()
        .filter(|p| p.status == PluginStatus::Error)
        .collect();
    let ready_plugins: Vec<&PluginState> = plugins
        .iter()
        .filter(|p| p.status == PluginStatus::Ready)
        .collect();
    let unloaded_plugins: Vec<&PluginState> = plugins
        .iter()
        .filter(|p| p.status == PluginStatus::Unloaded)
        .collect();

    let format_plugin = |plugin: &PluginState| -> String {
        let mut parts = vec![format!("{} ({})", plugin.name, plugin.status)];
        if let Some(ref error) = plugin.error {
            parts.push(format!("Error: {}", error));
        }
        if let Some(loaded_at) = plugin.loaded_at {
            parts.push(format!("Loaded at: {}", loaded_at));
        }
        parts.join(" - ")
    };

    let mut sections = Vec::new();

    if !loaded_plugins.is_empty() {
        let items: Vec<String> = loaded_plugins.iter().map(|p| format!("- {}", format_plugin(p))).collect();
        sections.push(format!("**Loaded Plugins:**\n{}", items.join("\n")));
    }

    if !error_plugins.is_empty() {
        let items: Vec<String> = error_plugins.iter().map(|p| format!("- {}", format_plugin(p))).collect();
        sections.push(format!("**Plugins with Errors:**\n{}", items.join("\n")));
    }

    if !ready_plugins.is_empty() {
        let items: Vec<String> = ready_plugins.iter().map(|p| format!("- {}", format_plugin(p))).collect();
        sections.push(format!("**Ready to Load:**\n{}", items.join("\n")));
    }

    if !unloaded_plugins.is_empty() {
        let items: Vec<String> = unloaded_plugins.iter().map(|p| format!("- {}", format_plugin(p))).collect();
        sections.push(format!("**Unloaded:**\n{}", items.join("\n")));
    }

    let protected_plugins = service.get_protected_plugins();
    let original_plugins = service.get_original_plugins();

    if !protected_plugins.is_empty() || !original_plugins.is_empty() {
        sections.push(format!(
            "**System Plugins:**\n- Protected: {}\n- Original (loaded at startup): {}",
            protected_plugins.join(", "),
            original_plugins.join(", "),
        ));
    }

    let text = if sections.is_empty() {
        "No plugins registered in the Plugin Manager.".to_string()
    } else {
        sections.join("\n\n")
    };

    let plugin_data: Vec<serde_json::Value> = plugins
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "status": p.status,
                "error": p.error,
                "createdAt": p.created_at,
                "loadedAt": p.loaded_at,
                "unloadedAt": p.unloaded_at,
                "isProtected": protected_plugins.contains(&p.name),
                "isOriginal": original_plugins.contains(&p.name),
            })
        })
        .collect();

    Ok(ProviderResult::with_all(
        text,
        json!({ "plugins": plugin_data }),
        json!({
            "totalPlugins": plugins.len(),
            "loadedCount": loaded_plugins.len(),
            "errorCount": error_plugins.len(),
            "readyCount": ready_plugins.len(),
            "unloadedCount": unloaded_plugins.len(),
            "protectedPlugins": protected_plugins,
            "originalPlugins": original_plugins,
        }),
    ))
}

// =====================================================================
// pluginConfigurationStatus provider
// =====================================================================

pub fn get_plugin_configuration_status(
    plugin_manager: &PluginManagerService,
    config_service: &PluginConfigurationService,
    plugin_configs: &[(&str, &std::collections::HashMap<String, Option<String>>)],
    env_vars: &std::collections::HashMap<String, String>,
) -> ProviderResult {
    let all_plugins = plugin_manager.get_all_plugins();

    if all_plugins.is_empty() {
        return ProviderResult::with_all(
            "No plugins registered.".to_string(),
            json!({ "plugins": [] }),
            json!({
                "configurationServicesAvailable": true,
                "totalPlugins": 0,
                "configuredPlugins": 0,
                "needsConfiguration": 0,
                "hasUnconfiguredPlugins": false,
            }),
        );
    }

    let mut configured_count = 0usize;
    let mut needs_config_count = 0usize;
    let mut plugin_statuses: Vec<serde_json::Value> = Vec::new();

    for plugin_state in &all_plugins {
        // Find config for this plugin
        let config_map = plugin_configs
            .iter()
            .find(|(name, _)| *name == plugin_state.name)
            .map(|(_, c)| *c);

        match config_map {
            Some(config) => {
                let status = config_service.get_plugin_config_status(config, env_vars);
                plugin_statuses.push(json!({
                    "name": plugin_state.name,
                    "status": plugin_state.status,
                    "configured": status.configured,
                    "missingKeys": status.missing_keys,
                    "totalKeys": status.total_keys,
                }));

                if status.configured {
                    configured_count += 1;
                } else {
                    needs_config_count += 1;
                }
            }
            None => {
                plugin_statuses.push(json!({
                    "name": plugin_state.name,
                    "status": plugin_state.status,
                    "configured": true,
                    "missingKeys": [],
                    "totalKeys": 0,
                }));
                configured_count += 1;
            }
        }
    }

    let mut status_text = format!(
        "Plugin Configuration Status:\nTotal: {}, Configured: {}, Needs config: {}\n",
        all_plugins.len(),
        configured_count,
        needs_config_count,
    );

    if needs_config_count > 0 {
        status_text.push_str("\nPlugins needing configuration:\n");
        for ps in &plugin_statuses {
            if ps.get("configured").and_then(|c| c.as_bool()) == Some(false) {
                let name = ps.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                let missing = ps
                    .get("missingKeys")
                    .and_then(|m| m.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                status_text.push_str(&format!("- {}: missing {}\n", name, missing));
            }
        }
    }

    ProviderResult::with_all(
        status_text,
        json!({ "plugins": plugin_statuses }),
        json!({
            "configurationServicesAvailable": true,
            "totalPlugins": all_plugins.len(),
            "configuredPlugins": configured_count,
            "needsConfiguration": needs_config_count,
            "hasUnconfiguredPlugins": needs_config_count > 0,
        }),
    )
}

// =====================================================================
// registryPlugins provider
// =====================================================================

pub async fn get_registry_plugins(
    plugin_manager: &PluginManagerService,
    registry_service: &PluginRegistryService,
) -> Result<ProviderResult> {
    let registry_result = registry_service.get_all_plugins().await;

    if !registry_result.from_api {
        let installed_plugins = plugin_manager.list_installed_plugins();
        let mut text = format!(
            "**Registry unavailable:** {}\n",
            registry_result.error.unwrap_or_default()
        );

        if !installed_plugins.is_empty() {
            text.push_str("\n**Locally Installed Plugins:**\n");
            for plugin in &installed_plugins {
                text.push_str(&format!(
                    "- **{}** v{} ({})\n",
                    plugin.name, plugin.version, plugin.status
                ));
            }
        }

        return Ok(ProviderResult::with_all(
            text,
            json!({
                "availablePlugins": [],
                "installedPlugins": installed_plugins.iter().map(|p| json!({
                    "name": p.name,
                    "version": p.version,
                    "status": p.status.to_string(),
                })).collect::<Vec<_>>(),
                "registryError": registry_result.error,
            }),
            json!({
                "availableCount": 0,
                "installedCount": installed_plugins.len(),
                "registryAvailable": false,
            }),
        ));
    }

    let plugins_data = registry_result.data;
    let plugins: Vec<serde_json::Value> = plugins_data
        .iter()
        .map(|plugin| {
            json!({
                "name": plugin.name,
                "description": plugin.description,
                "repository": plugin.repository,
                "tags": plugin.tags,
                "version": plugin.latest_version,
            })
        })
        .collect();

    let mut text = String::new();

    if plugins.is_empty() {
        text.push_str("No plugins available in registry.\n");
    } else {
        text.push_str(&format!(
            "**Available Plugins from Registry ({} total):**\n",
            plugins.len()
        ));
        for plugin in &plugins_data {
            text.push_str(&format!("- **{}**: {}\n", plugin.name, plugin.description));
            if let Some(ref tags) = plugin.tags {
                if !tags.is_empty() {
                    text.push_str(&format!("  Tags: {}\n", tags.join(", ")));
                }
            }
        }
    }

    let installed_plugins = plugin_manager.list_installed_plugins();
    if !installed_plugins.is_empty() {
        text.push_str("\n**Installed Registry Plugins:**\n");
        for plugin in &installed_plugins {
            text.push_str(&format!(
                "- **{}** v{} ({})\n",
                plugin.name, plugin.version, plugin.status
            ));
        }
    }

    Ok(ProviderResult::with_all(
        text,
        json!({
            "availablePlugins": plugins,
            "installedPlugins": installed_plugins.iter().map(|p| json!({
                "name": p.name,
                "version": p.version,
                "status": p.status.to_string(),
            })).collect::<Vec<_>>(),
        }),
        json!({
            "availableCount": plugins.len(),
            "installedCount": installed_plugins.len(),
            "registryAvailable": true,
        }),
    ))
}

// =====================================================================
// Tests
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_get_plugin_state_empty() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let result = get_plugin_state(&service).await;
        assert!(result.is_ok());
        let pr = result.unwrap();
        assert!(pr.text.contains("No plugins registered"));
    }

    #[tokio::test]
    async fn test_get_plugin_state_with_plugins() {
        let mut service = PluginManagerService::new(PluginManagerConfig::default());
        service.initialize_with_plugins(vec!["test-plugin".to_string()]);

        let result = get_plugin_state(&service).await;
        assert!(result.is_ok());
        let pr = result.unwrap();
        assert!(pr.text.contains("test-plugin"));
        assert!(pr.text.contains("Loaded Plugins"));
    }

    #[test]
    fn test_get_plugin_configuration_status_no_plugins() {
        let plugin_manager = PluginManagerService::new(PluginManagerConfig::default());
        let config_service = PluginConfigurationService::new();
        let env_vars = HashMap::new();

        let result = get_plugin_configuration_status(
            &plugin_manager,
            &config_service,
            &[],
            &env_vars,
        );
        assert!(result.text.contains("No plugins registered"));
    }

    #[test]
    fn test_get_plugin_configuration_status_with_missing() {
        let mut plugin_manager = PluginManagerService::new(PluginManagerConfig::default());
        plugin_manager.initialize_with_plugins(vec!["my-plugin".to_string()]);
        let config_service = PluginConfigurationService::new();

        let mut config = HashMap::new();
        config.insert("API_KEY".to_string(), None);

        let env_vars = HashMap::new();

        let result = get_plugin_configuration_status(
            &plugin_manager,
            &config_service,
            &[("my-plugin", &config)],
            &env_vars,
        );
        assert!(result.text.contains("Needs config: 1"));
        assert!(result.text.contains("API_KEY"));
    }
}
