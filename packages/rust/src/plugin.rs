//! Plugin loading and management for elizaOS
//!
//! This module provides functions for loading, validating, and resolving plugin dependencies.

use crate::types::plugin::{Plugin, PluginDefinition};
use anyhow::Result;
use lazy_static::lazy_static;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tracing::{debug, error, warn};

/// Factory function type for creating plugin instances.
pub type PluginFactory = Arc<dyn Fn() -> Plugin + Send + Sync>;

lazy_static! {
    static ref PLUGIN_REGISTRY: Mutex<HashMap<String, PluginFactory>> = Mutex::new(HashMap::new());
}

/// Register a plugin factory under a name
pub fn register_plugin_factory(name: &str, factory: PluginFactory) {
    let mut registry = PLUGIN_REGISTRY
        .lock()
        .expect("plugin registry lock poisoned");

    // Register exact name
    registry.insert(name.to_string(), factory.clone());

    // Register normalized name
    let normalized = normalize_plugin_name(name);
    registry.insert(normalized.clone(), factory.clone());

    // Register scoped alias if input is short name
    if !name.starts_with('@') {
        registry.insert(format!("@elizaos/plugin-{}", name), factory.clone());
    }

    // Register short alias if input is scoped name
    if let Some(short) = name.strip_prefix("@elizaos/plugin-") {
        registry.insert(short.to_string(), factory);
    }
}

/// List all registered plugin names (including aliases).
pub fn list_registered_plugins() -> Vec<String> {
    let registry = PLUGIN_REGISTRY
        .lock()
        .expect("plugin registry lock poisoned");
    let mut names: Vec<String> = registry.keys().cloned().collect();
    names.sort();
    names
}

/// Validate a plugin's structure
pub fn validate_plugin(plugin: &PluginDefinition) -> Result<()> {
    if plugin.name.is_empty() {
        anyhow::bail!("Plugin must have a name");
    }

    if plugin.description.is_empty() {
        anyhow::bail!("Plugin must have a description");
    }

    // Validate actions if present
    if let Some(actions) = &plugin.actions {
        for action in actions {
            if action.name.is_empty() {
                anyhow::bail!("Action must have a name");
            }
        }
    }

    // Validate providers if present
    if let Some(providers) = &plugin.providers {
        for provider in providers {
            if provider.name.is_empty() {
                anyhow::bail!("Provider must have a name");
            }
        }
    }

    Ok(())
}

/// Load a plugin by name
///
/// Rust does not have a built-in dynamic module loader analogous to JS `import()`.
/// To support the same workflow, the core provides a process-local registry of plugin factories.
/// Plugins (or the embedding application) register factories via `register_plugin_factory()`.
///
/// # Arguments
/// * `name` - The plugin name to load
///
/// # Returns
/// A Result containing the loaded Plugin or an error
pub fn load_plugin(name: &str) -> Result<Plugin> {
    debug!("Loading plugin: {}", name);

    let factory = {
        let registry = PLUGIN_REGISTRY
            .lock()
            .expect("plugin registry lock poisoned");
        registry
            .get(name)
            .cloned()
            .or_else(|| registry.get(&normalize_plugin_name(name)).cloned())
    };

    let factory = match factory {
        Some(f) => f,
        None => {
            anyhow::bail!(
                "Plugin '{}' not found. Register it first via register_plugin_factory().",
                name
            );
        }
    };

    let plugin = (factory)();
    validate_plugin(&plugin.definition)?;
    Ok(plugin)
}

/// Normalize a plugin name by extracting the short name from scoped packages
pub fn normalize_plugin_name(name: &str) -> String {
    // Match patterns like @elizaos/plugin-{name}
    if let Some(captures) = name.strip_prefix("@elizaos/plugin-") {
        return captures.to_string();
    }
    if let Some(captures) = name.strip_prefix("@").and_then(|s| s.split('/').nth(1)) {
        if let Some(short) = captures.strip_prefix("plugin-") {
            return short.to_string();
        }
    }
    name.to_string()
}

/// Resolve plugin dependencies with circular dependency detection
pub fn resolve_plugin_dependencies(
    plugins: &HashMap<String, Plugin>,
    is_test_mode: bool,
) -> Result<Vec<&Plugin>> {
    let mut resolution_order: Vec<String> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut visiting: HashSet<String> = HashSet::new();

    // Build lookup map with multiple name variants
    let mut lookup: HashMap<String, &Plugin> = HashMap::new();
    for (key, plugin) in plugins {
        lookup.insert(key.clone(), plugin);
        lookup.insert(plugin.definition.name.clone(), plugin);
        let normalized = normalize_plugin_name(key);
        if normalized != *key {
            lookup.insert(normalized, plugin);
        }
    }

    fn visit(
        name: &str,
        lookup: &HashMap<String, &Plugin>,
        visited: &mut HashSet<String>,
        visiting: &mut HashSet<String>,
        resolution_order: &mut Vec<String>,
        is_test_mode: bool,
    ) -> Result<()> {
        let plugin = match lookup.get(name) {
            Some(p) => p,
            None => {
                let normalized = normalize_plugin_name(name);
                match lookup.get(&normalized) {
                    Some(p) => p,
                    None => {
                        warn!("Plugin dependency not found: {}", name);
                        return Ok(());
                    }
                }
            }
        };

        let canonical_name = &plugin.definition.name;

        if visited.contains(canonical_name) {
            return Ok(());
        }

        if visiting.contains(canonical_name) {
            error!(
                "Circular dependency detected for plugin: {}",
                canonical_name
            );
            anyhow::bail!(
                "Circular dependency detected for plugin: {}",
                canonical_name
            );
        }

        visiting.insert(canonical_name.clone());

        // Process dependencies
        let deps: Vec<String> = plugin.definition.dependencies.clone().unwrap_or_default();

        for dep in deps {
            visit(
                &dep,
                lookup,
                visited,
                visiting,
                resolution_order,
                is_test_mode,
            )?;
        }

        // Process test dependencies if in test mode
        if is_test_mode {
            let test_deps: Vec<String> = plugin
                .definition
                .test_dependencies
                .clone()
                .unwrap_or_default();

            for dep in test_deps {
                visit(
                    &dep,
                    lookup,
                    visited,
                    visiting,
                    resolution_order,
                    is_test_mode,
                )?;
            }
        }

        visiting.remove(canonical_name);
        visited.insert(canonical_name.clone());
        resolution_order.push(canonical_name.clone());

        Ok(())
    }

    // Visit all plugins
    for plugin in plugins.values() {
        if !visited.contains(&plugin.definition.name) {
            visit(
                &plugin.definition.name,
                &lookup,
                &mut visited,
                &mut visiting,
                &mut resolution_order,
                is_test_mode,
            )?;
        }
    }

    // Map back to plugin references
    let final_plugins: Vec<&Plugin> = resolution_order
        .iter()
        .filter_map(|name| plugins.values().find(|p| &p.definition.name == name))
        .collect();

    debug!(
        "Plugins resolved: {:?}",
        final_plugins
            .iter()
            .map(|p| &p.definition.name)
            .collect::<Vec<_>>()
    );

    Ok(final_plugins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::plugin::PluginDefinition;
    use std::sync::Arc;

    fn create_test_plugin(name: &str, deps: Vec<&str>) -> Plugin {
        Plugin {
            definition: PluginDefinition {
                name: name.to_string(),
                description: format!("{} plugin", name),
                dependencies: if deps.is_empty() {
                    None
                } else {
                    Some(deps.into_iter().map(String::from).collect())
                },
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_normalize_plugin_name() {
        assert_eq!(normalize_plugin_name("@elizaos/plugin-discord"), "discord");
        assert_eq!(normalize_plugin_name("@elizaos/plugin-sql"), "sql");
        assert_eq!(normalize_plugin_name("bootstrap"), "bootstrap");
    }

    #[test]
    fn test_validate_plugin() {
        let plugin = PluginDefinition {
            name: "test".to_string(),
            description: "Test plugin".to_string(),
            ..Default::default()
        };

        assert!(validate_plugin(&plugin).is_ok());
    }

    #[test]
    fn test_validate_plugin_empty_name() {
        let plugin = PluginDefinition {
            name: "".to_string(),
            description: "Test plugin".to_string(),
            ..Default::default()
        };

        assert!(validate_plugin(&plugin).is_err());
    }

    #[test]
    fn test_resolve_plugin_dependencies_simple() {
        let mut plugins = HashMap::new();
        plugins.insert("a".to_string(), create_test_plugin("a", vec![]));
        plugins.insert("b".to_string(), create_test_plugin("b", vec!["a"]));
        plugins.insert("c".to_string(), create_test_plugin("c", vec!["b"]));

        let resolved = resolve_plugin_dependencies(&plugins, false).unwrap();
        let names: Vec<&str> = resolved
            .iter()
            .map(|p| p.definition.name.as_str())
            .collect();

        // a should come before b, b should come before c
        let a_pos = names.iter().position(|&n| n == "a").unwrap();
        let b_pos = names.iter().position(|&n| n == "b").unwrap();
        let c_pos = names.iter().position(|&n| n == "c").unwrap();

        assert!(a_pos < b_pos);
        assert!(b_pos < c_pos);
    }

    #[test]
    fn test_resolve_plugin_dependencies_circular() {
        let mut plugins = HashMap::new();
        plugins.insert("a".to_string(), create_test_plugin("a", vec!["b"]));
        plugins.insert("b".to_string(), create_test_plugin("b", vec!["a"]));

        let result = resolve_plugin_dependencies(&plugins, false);
        assert!(result.is_err());
    }

    #[test]
    fn test_load_plugin_from_registry() {
        let plugin_name = "registry-test-plugin";
        register_plugin_factory(
            plugin_name,
            Arc::new(|| Plugin::new(plugin_name, "Test plugin from registry")),
        );

        let loaded = load_plugin(plugin_name).unwrap();
        assert_eq!(loaded.definition.name, plugin_name);
    }
}
