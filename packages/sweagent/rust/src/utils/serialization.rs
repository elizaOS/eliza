//! Serialization utilities for SWE-agent

use crate::exceptions::{Result, SWEAgentError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Convert a value to YAML string with proper line breaks
pub fn to_yaml_with_linebreaks<T: Serialize>(value: &T) -> Result<String> {
    serde_yaml::to_string(value).map_err(|e| SWEAgentError::SerializationError(e.to_string()))
}

/// Convert to YAML literal string (preserving multiline formatting)
pub fn convert_to_yaml_literal_string(s: &str) -> String {
    if s.contains('\n') {
        format!("|\n{}", indent_string(s, 2))
    } else {
        serde_yaml::to_string(&s).unwrap_or_else(|_| format!("\"{}\"", s.replace('"', "\\\"")))
    }
}

/// Indent a string by a given number of spaces
fn indent_string(s: &str, spaces: usize) -> String {
    let indent = " ".repeat(spaces);
    s.lines()
        .map(|line| format!("{}{}", indent, line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Merge two nested dictionaries
pub fn merge_nested_dicts(
    base: &HashMap<String, serde_json::Value>,
    overlay: &HashMap<String, serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
    let mut result = base.clone();

    for (key, value) in overlay {
        let should_merge = result.get(key).map(|base_value| {
            matches!(
                (base_value, value),
                (serde_json::Value::Object(_), serde_json::Value::Object(_))
            )
        });

        match should_merge {
            Some(true) => {
                if let (
                    Some(serde_json::Value::Object(base_obj)),
                    serde_json::Value::Object(overlay_obj),
                ) = (result.get(key), value)
                {
                    let base_map: HashMap<String, serde_json::Value> = base_obj
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    let overlay_map: HashMap<String, serde_json::Value> = overlay_obj
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    let merged = merge_nested_dicts(&base_map, &overlay_map);
                    result.insert(
                        key.clone(),
                        serde_json::Value::Object(merged.into_iter().collect()),
                    );
                }
            }
            Some(false) => {
                result.insert(key.clone(), value.clone());
            }
            None => {
                result.insert(key.clone(), value.clone());
            }
        }
    }

    result
}

/// Parse arguments into a nested dictionary
pub fn parse_args_to_nested_dict(args: &[String]) -> HashMap<String, serde_json::Value> {
    let mut result = HashMap::new();

    for arg in args {
        if let Some(eq_pos) = arg.find('=') {
            let key = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];

            // Parse the key path (e.g., "agent.model.name")
            let parts: Vec<&str> = key.split('.').collect();
            set_nested_value(&mut result, &parts, value);
        }
    }

    result
}

/// Set a value in a nested dictionary
fn set_nested_value(dict: &mut HashMap<String, serde_json::Value>, path: &[&str], value: &str) {
    if path.is_empty() {
        return;
    }

    if path.len() == 1 {
        // Try to parse as JSON, otherwise use as string
        let json_value = serde_json::from_str(value)
            .unwrap_or_else(|_| serde_json::Value::String(value.to_string()));
        dict.insert(path[0].to_string(), json_value);
    } else {
        let entry = dict
            .entry(path[0].to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

        if let serde_json::Value::Object(obj) = entry {
            let mut inner: HashMap<String, serde_json::Value> =
                obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            set_nested_value(&mut inner, &path[1..], value);
            *obj = inner.into_iter().collect();
        }
    }
}

/// Shorten a string to a maximum length
pub fn shorten_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}

/// Shorten all strings in a dictionary
pub fn shorten_strings(dict: &HashMap<String, String>, max_len: usize) -> HashMap<String, String> {
    dict.iter()
        .map(|(k, v)| (k.clone(), shorten_string(v, max_len)))
        .collect()
}

/// Load a trajectory from a file
pub fn load_trajectory<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Result<T> {
    let contents = std::fs::read_to_string(path)?;
    serde_json::from_str(&contents).map_err(|e| SWEAgentError::SerializationError(e.to_string()))
}

/// Save a trajectory to a file
pub fn save_trajectory<T: Serialize>(path: &std::path::Path, data: &T) -> Result<()> {
    let contents = serde_json::to_string_pretty(data)?;
    std::fs::write(path, contents)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shorten_string() {
        assert_eq!(shorten_string("hello", 10), "hello");
        assert_eq!(shorten_string("hello world", 8), "hello...");
    }

    #[test]
    fn test_convert_to_yaml_literal_string() {
        let single = convert_to_yaml_literal_string("hello");
        assert!(!single.starts_with('|'));

        let multi = convert_to_yaml_literal_string("hello\nworld");
        assert!(multi.starts_with('|'));
    }

    #[test]
    fn test_parse_args_to_nested_dict() {
        let args = vec![
            "agent.model.name=gpt-4".to_string(),
            "env.timeout=30".to_string(),
        ];
        let dict = parse_args_to_nested_dict(&args);

        assert!(dict.contains_key("agent"));
        assert!(dict.contains_key("env"));
    }
}
