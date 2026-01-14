//! Tool registry for managing available tools

use super::{create_bundle, Bundle, BundleConfig};
use crate::exceptions::Result;
use std::collections::HashMap;

/// Registry of available tools
pub struct ToolRegistry {
    tools: HashMap<String, Bundle>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a tool bundle
    pub fn register(&mut self, bundle: Bundle) {
        self.tools.insert(bundle.name.clone(), bundle);
    }

    /// Register a tool from configuration
    pub fn register_config(&mut self, config: &BundleConfig) -> Result<()> {
        let bundle = create_bundle(config)?;
        self.register(bundle);
        Ok(())
    }

    /// Get a tool by name
    pub fn get(&self, name: &str) -> Option<&Bundle> {
        self.tools.get(name)
    }

    /// Check if a tool exists
    pub fn has(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Get all registered tools
    pub fn all(&self) -> Vec<&Bundle> {
        self.tools.values().collect()
    }

    /// Get tool names
    pub fn names(&self) -> Vec<&str> {
        self.tools.keys().map(|s| s.as_str()).collect()
    }

    /// Remove a tool
    pub fn remove(&mut self, name: &str) -> Option<Bundle> {
        self.tools.remove(name)
    }

    /// Clear all tools
    pub fn clear(&mut self) {
        self.tools.clear();
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a registry with default SWE-agent tools
pub fn create_default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();

    // Register common tools
    registry.register(
        Bundle::new("edit")
            .with_end_name("ENDEDIT")
            .with_description("Edit a file")
            .with_signature("edit <file> <start_line> <end_line>"),
    );

    registry.register(
        Bundle::new("view")
            .with_description("View a file or directory")
            .with_signature("view <path> [start_line] [end_line]"),
    );

    registry.register(
        Bundle::new("search")
            .with_description("Search for a pattern in files")
            .with_signature("search <pattern> [path]"),
    );

    registry.register(
        Bundle::new("find_file")
            .with_description("Find files by name")
            .with_signature("find_file <pattern> [directory]"),
    );

    registry.register(
        Bundle::new("submit")
            .with_description("Submit the solution")
            .with_signature("submit"),
    );

    registry.register(
        Bundle::new("exit")
            .with_description("Exit without submitting")
            .with_signature("exit"),
    );

    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_register() {
        let mut registry = ToolRegistry::new();
        registry.register(Bundle::new("test"));

        assert!(registry.has("test"));
        assert!(!registry.has("nonexistent"));
    }

    #[test]
    fn test_registry_get() {
        let mut registry = ToolRegistry::new();
        registry.register(Bundle::new("test").with_description("A test tool"));

        let bundle = registry.get("test").unwrap();
        assert_eq!(bundle.description, Some("A test tool".to_string()));
    }

    #[test]
    fn test_default_registry() {
        let registry = create_default_registry();

        assert!(registry.has("edit"));
        assert!(registry.has("view"));
        assert!(registry.has("submit"));
    }
}
