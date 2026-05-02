//! Settings types for elizaOS
//!
//! Contains runtime settings and configuration types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Runtime settings
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    /// Settings values
    #[serde(flatten)]
    pub values: HashMap<String, SettingValue>,
}

/// Setting value type
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingValue {
    /// String value
    String(String),
    /// Boolean value
    Bool(bool),
    /// Number value
    Number(f64),
    /// Null value
    Null,
}

impl RuntimeSettings {
    /// Create new empty settings
    pub fn new() -> Self {
        RuntimeSettings::default()
    }

    /// Get a string setting
    pub fn get_string(&self, key: &str) -> Option<&str> {
        match self.values.get(key) {
            Some(SettingValue::String(s)) => Some(s),
            _ => None,
        }
    }

    /// Get a bool setting
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        match self.values.get(key) {
            Some(SettingValue::Bool(b)) => Some(*b),
            _ => None,
        }
    }

    /// Get a number setting
    pub fn get_number(&self, key: &str) -> Option<f64> {
        match self.values.get(key) {
            Some(SettingValue::Number(n)) => Some(*n),
            _ => None,
        }
    }

    /// Set a string setting
    pub fn set_string(&mut self, key: &str, value: &str) {
        self.values
            .insert(key.to_string(), SettingValue::String(value.to_string()));
    }

    /// Set a bool setting
    pub fn set_bool(&mut self, key: &str, value: bool) {
        self.values
            .insert(key.to_string(), SettingValue::Bool(value));
    }

    /// Set a number setting
    pub fn set_number(&mut self, key: &str, value: f64) {
        self.values
            .insert(key.to_string(), SettingValue::Number(value));
    }

    /// Check if a key exists
    pub fn has(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    /// Remove a setting
    pub fn remove(&mut self, key: &str) -> Option<SettingValue> {
        self.values.remove(key)
    }
}

impl From<HashMap<String, String>> for RuntimeSettings {
    fn from(map: HashMap<String, String>) -> Self {
        let values = map
            .into_iter()
            .map(|(k, v)| (k, SettingValue::String(v)))
            .collect();
        RuntimeSettings { values }
    }
}

/// Environment configuration
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentConfig {
    /// Database URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_url: Option<String>,
    /// Log level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// Whether in development mode
    #[serde(skip_serializing_if = "Option::is_none")]
    pub development: Option<bool>,
    /// Additional settings
    #[serde(flatten)]
    pub extra: HashMap<String, String>,
}

impl EnvironmentConfig {
    /// Load from environment variables
    pub fn from_env() -> Self {
        let mut config = EnvironmentConfig::default();

        if let Ok(url) = std::env::var("DATABASE_URL") {
            config.database_url = Some(url);
        }
        if let Ok(level) = std::env::var("LOG_LEVEL") {
            config.log_level = Some(level);
        }
        if let Ok(dev) = std::env::var("DEVELOPMENT") {
            config.development = Some(dev == "true" || dev == "1");
        }

        config
    }

    /// Get a string from environment or config
    pub fn get(&self, key: &str) -> Option<String> {
        // Check environment first
        if let Ok(val) = std::env::var(key) {
            return Some(val);
        }
        // Then check extra config
        self.extra.get(key).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_runtime_settings() {
        let mut settings = RuntimeSettings::new();
        settings.set_string("name", "TestAgent");
        settings.set_bool("enabled", true);
        settings.set_number("timeout", 30.0);

        assert_eq!(settings.get_string("name"), Some("TestAgent"));
        assert_eq!(settings.get_bool("enabled"), Some(true));
        assert_eq!(settings.get_number("timeout"), Some(30.0));
    }

    #[test]
    fn test_settings_serialization() {
        let mut settings = RuntimeSettings::new();
        settings.set_string("key", "value");
        settings.set_bool("flag", true);

        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"key\":\"value\""));
        assert!(json.contains("\"flag\":true"));
    }

    #[test]
    fn test_settings_from_hashmap() {
        let mut map = HashMap::new();
        map.insert("key1".to_string(), "value1".to_string());
        map.insert("key2".to_string(), "value2".to_string());

        let settings: RuntimeSettings = map.into();
        assert_eq!(settings.get_string("key1"), Some("value1"));
        assert_eq!(settings.get_string("key2"), Some("value2"));
    }
}
