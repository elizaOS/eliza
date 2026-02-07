#![allow(missing_docs)]

use regex::Regex;
use serde_json::{json, Value};

use crate::error::{PluginManagerError, Result};
use crate::service::{PluginManagerService, PluginRegistryService};
use crate::types::*;

pub type ActionHandler = fn(
    &PluginManagerService,
    Value,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ActionResult>> + Send + '_>>;

// =====================================================================
// LOAD_PLUGIN
// =====================================================================

pub async fn load_plugin(
    service: &PluginManagerService,
    params: Value,
) -> Result<ActionResult> {
    let message_text = params
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_lowercase();

    let plugins = service.get_all_plugins();

    // Find plugin to load - try exact name match first
    let plugin_to_load = plugins
        .iter()
        .find(|p| {
            message_text.contains(&p.name.to_lowercase())
                && (p.status == PluginStatus::Ready || p.status == PluginStatus::Unloaded)
        })
        .or_else(|| {
            plugins
                .iter()
                .find(|p| p.status == PluginStatus::Ready || p.status == PluginStatus::Unloaded)
        });

    let plugin = match plugin_to_load {
        Some(p) => p,
        None => {
            return Ok(ActionResult::error(
                "No plugins are available to load. All plugins are either already loaded or have errors.",
            ));
        }
    };

    let load_params = LoadPluginParams {
        plugin_id: plugin.id.clone(),
        force: false,
    };

    match service.load_plugin(&load_params) {
        Ok(()) => Ok(ActionResult::success(format!(
            "Successfully loaded plugin: {}",
            plugin.name
        ))),
        Err(e) => Ok(ActionResult::error(format!(
            "Failed to load plugin {}: {}",
            plugin.name, e
        ))),
    }
}

// =====================================================================
// UNLOAD_PLUGIN
// =====================================================================

pub async fn unload_plugin(
    service: &PluginManagerService,
    params: Value,
) -> Result<ActionResult> {
    let message_text = params
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_lowercase();

    let plugins = service.get_all_plugins();

    // Find plugin to unload - try exact name match
    let plugin_to_unload = plugins.iter().find(|p| {
        message_text.contains(&p.name.to_lowercase()) && p.status == PluginStatus::Loaded
    });

    let plugin = match plugin_to_unload {
        Some(p) => p,
        None => {
            let loaded_plugins: Vec<&PluginState> = plugins
                .iter()
                .filter(|p| {
                    p.status == PluginStatus::Loaded && service.can_unload_plugin(&p.name)
                })
                .collect();

            if loaded_plugins.is_empty() {
                return Ok(ActionResult::error(
                    "No plugins are currently loaded that can be unloaded. All loaded plugins are protected system plugins.",
                ));
            }

            let names: Vec<&str> = loaded_plugins.iter().map(|p| p.name.as_str()).collect();
            return Ok(ActionResult::error(format!(
                "Please specify which plugin to unload. Available plugins that can be unloaded: {}",
                names.join(", ")
            )));
        }
    };

    if !service.can_unload_plugin(&plugin.name) {
        let reason = service
            .get_protection_reason(&plugin.name)
            .unwrap_or_else(|| "Plugin is protected".to_string());
        return Ok(ActionResult::error(format!(
            "Cannot unload plugin: {}",
            reason
        )));
    }

    let unload_params = UnloadPluginParams {
        plugin_id: plugin.id.clone(),
    };

    match service.unload_plugin(&unload_params) {
        Ok(()) => Ok(ActionResult::success(format!(
            "Successfully unloaded plugin: {}",
            plugin.name
        ))),
        Err(e) => Ok(ActionResult::error(format!(
            "Failed to unload plugin {}: {}",
            plugin.name, e
        ))),
    }
}

// =====================================================================
// INSTALL_PLUGIN_FROM_REGISTRY
// =====================================================================

pub async fn install_plugin_from_registry(
    service: &PluginManagerService,
    params: Value,
) -> Result<ActionResult> {
    let content = params
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_lowercase();

    let plugin_name = extract_install_plugin_name(&content);

    let name = match plugin_name {
        Some(n) => n,
        None => {
            return Ok(ActionResult::error(
                "Please specify a plugin name to install. Example: \"install plugin @elizaos/plugin-example\"",
            ));
        }
    };

    // Fetch registry to verify plugin exists
    match service.fetch_registry().await {
        Ok(registry) => {
            if !registry.contains_key(&name) {
                return Ok(ActionResult::error(format!(
                    "Plugin {} not found in registry",
                    name
                )));
            }

            let info = DynamicPluginInfo {
                name: name.clone(),
                version: "latest".to_string(),
                status: DynamicPluginStatus::Installed,
                path: format!("./plugins/installed/{}", name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_")),
                required_env_vars: vec![],
                error_details: None,
                installed_at: chrono::Utc::now().to_rfc3339(),
                last_activated: None,
            };

            service.record_installed_plugin(&name, info);

            Ok(ActionResult::success_with_data(
                format!(
                    "Successfully installed plugin {} and registered it. Use \"load plugin {}\" to activate it.",
                    name, name
                ),
                json!({ "pluginName": name, "status": "installed" }),
            ))
        }
        Err(e) => Ok(ActionResult::error(format!(
            "Failed to install plugin {}: {}",
            name, e
        ))),
    }
}

fn extract_install_plugin_name(text: &str) -> Option<String> {
    // Pattern 1: install [plugin] from registry <name>
    let re1 = Regex::new(r"install\s+(?:plugin\s+)?from\s+registry\s+(\S+)").ok()?;
    if let Some(caps) = re1.captures(text) {
        return caps.get(1).map(|m| m.as_str().to_string());
    }

    // Pattern 2: install [plugin] <name> [from registry]
    let re2 = Regex::new(r"install\s+(?:plugin\s+)?(\S+?)(?:\s+from\s+registry)?$").ok()?;
    if let Some(caps) = re2.captures(text) {
        let name = caps.get(1).map(|m| m.as_str())?;
        if name != "from" {
            return Some(name.to_string());
        }
    }

    // Pattern 3: add/download/get plugin <name>
    let re3 = Regex::new(r"(?:add|download|get)\s+(?:plugin\s+)?(\S+)").ok()?;
    re3.captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

// =====================================================================
// SEARCH_PLUGINS
// =====================================================================

pub async fn search_plugins(
    registry_service: &PluginRegistryService,
    params: Value,
) -> Result<ActionResult> {
    let text = params
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("");

    let query = match extract_search_query(text) {
        Some(q) => q,
        None => {
            return Ok(ActionResult::error(
                "Please specify what kind of functionality or features you're looking for in a plugin.",
            ));
        }
    };

    let search_result = registry_service.search_plugins(&query).await;

    if !search_result.from_api {
        return Ok(ActionResult::error(format!(
            "Could not reach the plugin registry: {}",
            search_result.error.unwrap_or_default()
        )));
    }

    let results = search_result.data;
    if results.is_empty() {
        return Ok(ActionResult::error(format!(
            "No plugins found matching \"{}\".",
            query
        )));
    }

    let mut response_text = format!(
        "Found {} plugin{} matching \"{}\":\n\n",
        results.len(),
        if results.len() > 1 { "s" } else { "" },
        query
    );

    for (index, plugin) in results.iter().enumerate() {
        let score = plugin
            .score
            .map(|s| format!(" (Score: {:.0}%)", s * 100.0))
            .unwrap_or_default();

        response_text.push_str(&format!("{}. **{}**{}\n", index + 1, plugin.name, score));

        response_text.push_str(&format!("   {}\n", plugin.description));

        if let Some(ref tags) = plugin.tags {
            if !tags.is_empty() {
                let display_tags: Vec<&str> = tags.iter().take(5).map(|s| s.as_str()).collect();
                response_text.push_str(&format!("   Tags: {}\n", display_tags.join(", ")));
            }
        }

        if let Some(ref version) = plugin.version {
            response_text.push_str(&format!("   Version: {}\n", version));
        }

        response_text.push('\n');
    }

    response_text.push_str("Next steps:\n");
    response_text.push_str("- Say \"tell me more about [plugin-name]\" for detailed info\n");
    response_text.push_str("- Say \"install [plugin-name]\" to install a plugin\n");
    response_text.push_str("- Say \"clone [plugin-name]\" to clone for development");

    Ok(ActionResult::success_with_data(
        response_text,
        json!({ "resultCount": results.len(), "query": query }),
    ))
}

fn extract_search_query(text: &str) -> Option<String> {
    let patterns = [
        r"search\s+for\s+plugins?\s+(?:that\s+)?(?:can\s+)?(.+)",
        r"find\s+plugins?\s+(?:for|that|to)\s+(.+)",
        r"look\s+for\s+plugins?\s+(?:that\s+)?(.+)",
        r"discover\s+plugins?\s+(?:for|that)\s+(.+)",
        r"show\s+me\s+plugins?\s+(?:for|that)\s+(.+)",
        r"need\s+(?:a\s+)?plugins?\s+(?:for|that|to)\s+(.+)",
        r"want\s+(?:a\s+)?plugins?\s+(?:for|that|to)\s+(.+)",
        r"plugins?\s+(?:for|that\s+can|to)\s+(.+)",
        r"plugins?\s+(.+)",
    ];

    for pattern in &patterns {
        if let Ok(re) = Regex::new(&format!("(?i){}", pattern)) {
            if let Some(caps) = re.captures(text) {
                if let Some(m) = caps.get(1) {
                    let mut query = m.as_str().trim().to_string();
                    // Clean up
                    query = query.trim_end_matches('?').to_string();
                    query = Regex::new(r"(?i)^(do|handle|manage|work\s+with)\s+")
                        .ok()
                        .and_then(|re| Some(re.replace(&query, "").to_string()))
                        .unwrap_or(query);

                    if query.len() > 2 {
                        return Some(query);
                    }
                }
            }
        }
    }

    // Fallback: extract technology keywords
    let tech_re = Regex::new(
        r"(?i)\b(blockchain|ai|database|api|social|twitter|discord|telegram|solana|ethereum|trading|defi|nft|authentication|security|monitoring|analytics|file|image|video|audio|email|sms|payment)\b",
    ).ok()?;

    let keywords: Vec<String> = tech_re
        .find_iter(text)
        .map(|m| m.as_str().to_string())
        .collect();

    if !keywords.is_empty() {
        Some(keywords.join(" "))
    } else {
        None
    }
}

// =====================================================================
// GET_PLUGIN_DETAILS
// =====================================================================

pub async fn get_plugin_details(
    registry_service: &PluginRegistryService,
    params: Value,
) -> Result<ActionResult> {
    let text = params.get("text").and_then(|t| t.as_str()).unwrap_or("");

    let plugin_name_re = Regex::new(r"@?([\w-]+/plugin-[\w-]+|plugin-[\w-]+)")
        .map_err(|e| PluginManagerError::InvalidInput(e.to_string()))?;

    let plugin_name = match plugin_name_re.captures(text) {
        Some(caps) => {
            let mut name = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            if !name.starts_with('@') && !name.contains('/') {
                name = format!("@elizaos/{}", name);
            }
            name
        }
        None => {
            return Ok(ActionResult::error(
                "Please specify which plugin you'd like to know more about.",
            ));
        }
    };

    let details_result = registry_service.get_plugin_details(&plugin_name).await;

    if !details_result.from_api {
        return Ok(ActionResult::error(format!(
            "Could not reach the plugin registry: {}",
            details_result.error.unwrap_or_default()
        )));
    }

    let details = match details_result.data {
        Some(d) => d,
        None => {
            return Ok(ActionResult::error(format!(
                "Plugin \"{}\" not found in the registry.",
                plugin_name
            )));
        }
    };

    let mut response_text = format!("**{}** Details:\n\n", details.name);
    response_text.push_str(&format!("Description: {}\n\n", details.description));

    if let Some(ref tags) = details.tags {
        if !tags.is_empty() {
            response_text.push_str(&format!("Tags: {}\n\n", tags.join(", ")));
        }
    }

    response_text.push_str(&format!("Version: {}\n", details.latest_version));
    response_text.push_str(&format!("Repository: {}\n", details.repository));
    response_text.push_str(&format!("\nTo install: \"install {}\"", details.name));

    Ok(ActionResult::success_with_data(
        response_text,
        json!({
            "name": details.name,
            "version": details.latest_version,
            "repository": details.repository,
        }),
    ))
}

// =====================================================================
// CLONE_PLUGIN
// =====================================================================

pub async fn clone_plugin(
    registry_service: &PluginRegistryService,
    params: Value,
) -> Result<ActionResult> {
    let text = params.get("text").and_then(|t| t.as_str()).unwrap_or("");

    let plugin_name = match extract_clone_plugin_name(text) {
        Some(name) => name,
        None => {
            return Ok(ActionResult::error(
                "Please specify which plugin you want to clone. For example: \"clone the weather plugin\" or \"clone @elizaos/plugin-weather\"",
            ));
        }
    };

    let result = registry_service.clone_plugin(&plugin_name).await;

    if !result.success {
        return Ok(ActionResult::error(format!(
            "Failed to clone plugin: {}",
            result.error.unwrap_or_default()
        )));
    }

    let mut response_text = format!(
        "Successfully cloned **{}** to `{}`\n\n",
        result.plugin_name.as_deref().unwrap_or(&plugin_name),
        result.local_path.as_deref().unwrap_or("./cloned-plugins/"),
    );
    response_text.push_str("You can now:\n");
    response_text.push_str("- Edit the plugin code in your preferred editor\n");
    response_text.push_str("- Run tests with `npm test` or `pnpm test`\n");
    response_text.push_str("- Build with `npm run build` or `pnpm build`\n");
    response_text.push_str("- Use the plugin-autocoder to make AI-assisted modifications\n");

    if result.has_tests == Some(true) {
        response_text.push_str(
            "\nNote: This plugin has existing tests. Run them to ensure everything works before making changes.",
        );
    }

    Ok(ActionResult::success_with_data(
        response_text,
        json!({
            "pluginName": result.plugin_name,
            "localPath": result.local_path,
        }),
    ))
}

fn extract_clone_plugin_name(text: &str) -> Option<String> {
    // Try explicit plugin names
    let patterns = [r"@elizaos/plugin-[\w-]+", r"plugin-[\w-]+"];

    for pattern in &patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(m) = re.find(text) {
                return Some(m.as_str().to_string());
            }
        }
    }

    // Try natural language extraction: "clone the X plugin"
    let words: Vec<&str> = text.to_lowercase().split_whitespace().collect();
    if let Some(clone_idx) = words.iter().position(|&w| w == "clone") {
        for i in (clone_idx + 1)..words.len() {
            if words[i] == "plugin" && i > clone_idx + 1 {
                let plugin_type = words[i - 1];
                if plugin_type != "the" {
                    return Some(format!("@elizaos/plugin-{}", plugin_type));
                }
            }
        }
    }

    None
}

// =====================================================================
// PUBLISH_PLUGIN
// =====================================================================

pub async fn publish_plugin(
    _service: &PluginManagerService,
    _params: Value,
) -> Result<ActionResult> {
    // Temporarily disabled while migrating to new registry system
    Ok(ActionResult::success(
        "Plugin publishing is temporarily unavailable while we migrate to the new registry system.\n\n\
        You can still publish manually using:\n\
        npm publish --access public\n\n\
        Make sure to:\n\
        1. Run tests with `npm test`\n\
        2. Build with `npm run build`\n\
        3. Login to npm with `npm login`",
    ))
}

// =====================================================================
// Tests
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_install_plugin_name() {
        assert_eq!(
            extract_install_plugin_name("install plugin @elizaos/plugin-weather from registry"),
            Some("@elizaos/plugin-weather".to_string())
        );

        assert_eq!(
            extract_install_plugin_name("install @elizaos/plugin-test"),
            Some("@elizaos/plugin-test".to_string())
        );

        assert_eq!(
            extract_install_plugin_name("add plugin my-plugin"),
            Some("my-plugin".to_string())
        );

        assert_eq!(extract_install_plugin_name("do something"), None);
    }

    #[test]
    fn test_extract_search_query() {
        assert!(extract_search_query("search for plugins that handle blockchain transactions")
            .is_some());

        assert!(extract_search_query("find plugins for social media").is_some());

        assert!(extract_search_query("plugins for solana").is_some());

        assert!(extract_search_query("blockchain").is_some());

        // Very short/empty queries
        assert!(extract_search_query("hi").is_none());
    }

    #[test]
    fn test_extract_clone_plugin_name() {
        assert_eq!(
            extract_clone_plugin_name("clone @elizaos/plugin-weather"),
            Some("@elizaos/plugin-weather".to_string())
        );

        assert_eq!(
            extract_clone_plugin_name("clone plugin-test"),
            Some("plugin-test".to_string())
        );

        assert_eq!(extract_clone_plugin_name("do something"), None);
    }

    #[tokio::test]
    async fn test_load_plugin_no_plugins_available() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let result = load_plugin(&service, json!({ "text": "load my-plugin" })).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(!action_result.success);
        assert!(action_result.text.contains("No plugins are available"));
    }

    #[tokio::test]
    async fn test_load_plugin_success() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        service
            .register_plugin("my-plugin", "plugin-my-plugin")
            .unwrap();

        let result = load_plugin(&service, json!({ "text": "load my-plugin" })).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(action_result.success);
        assert!(action_result.text.contains("Successfully loaded"));
    }

    #[tokio::test]
    async fn test_unload_plugin_no_unloadable() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let result = unload_plugin(&service, json!({ "text": "unload something" })).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(!action_result.success);
    }

    #[tokio::test]
    async fn test_publish_plugin_disabled() {
        let service = PluginManagerService::new(PluginManagerConfig::default());
        let result = publish_plugin(&service, json!({})).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(action_result.text.contains("temporarily unavailable"));
    }
}
