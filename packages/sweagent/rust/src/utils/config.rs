//! Configuration utilities for SWE-agent

use crate::exceptions::{Result, SWEAgentError};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

/// Load environment variables from a .env file
pub fn load_environment_variables(path: Option<&Path>) -> Result<()> {
    if let Some(p) = path {
        if p.exists() {
            dotenvy::from_path(p).map_err(|e| {
                SWEAgentError::ConfigurationError(format!("Failed to load env file: {}", e))
            })?;
        }
    } else {
        // Try to load from default locations
        let _ = dotenvy::dotenv();
    }
    Ok(())
}

/// Convert a path relative to repo root to absolute path
pub fn convert_path_relative_to_repo_root(path: &str, repo_root: &Path) -> PathBuf {
    if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        repo_root.join(path)
    }
}

/// Convert a path to absolute path
pub fn convert_path_to_abspath(path: &str, base: &Path) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

/// Strip absolute path prefixes from dictionary values
pub fn strip_abspath_from_dict(
    dict: &HashMap<String, String>,
    prefix: &str,
) -> HashMap<String, String> {
    dict.iter()
        .map(|(k, v)| {
            let new_v = if v.starts_with(prefix) {
                v.strip_prefix(prefix).unwrap_or(v).to_string()
            } else {
                v.clone()
            };
            (k.clone(), new_v)
        })
        .collect()
}

/// Check if a string could be a file path
pub fn could_be_a_path(s: &str) -> bool {
    // Check for common path indicators
    s.contains('/') || s.contains('\\') || s.starts_with('.') || s.contains('.')
}

/// Get an environment variable with optional default
pub fn get_env_var(name: &str, default: Option<&str>) -> Option<String> {
    env::var(name).ok().or_else(|| default.map(String::from))
}

/// Get an API key from environment
pub fn get_api_key(provider: &str) -> Option<String> {
    let key_name = format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"));
    env::var(&key_name).ok()
}

/// Parse API keys that may be separated by :::
pub fn parse_api_keys(key_string: &str) -> Vec<String> {
    key_string
        .split(":::")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_could_be_a_path() {
        assert!(could_be_a_path("/home/user/file.txt"));
        assert!(could_be_a_path("./relative/path"));
        assert!(could_be_a_path("file.py"));
        assert!(!could_be_a_path("simple_string"));
    }

    #[test]
    fn test_parse_api_keys() {
        let keys = parse_api_keys("key1:::key2:::key3");
        assert_eq!(keys, vec!["key1", "key2", "key3"]);

        let single = parse_api_keys("single_key");
        assert_eq!(single, vec!["single_key"]);
    }
}
