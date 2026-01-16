use regex::Regex;
use serde_json::Value;
use similar::{ChangeTag, TextDiff};

/// Remove id and element_id fields from UI tree JSON
/// Port of Python's remove_ids() function from sequential_processor.py
pub fn remove_ids(value: &Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.iter().map(remove_ids).collect()),
        Value::Object(obj) => {
            let mut new_obj = serde_json::Map::new();
            for (key, val) in obj.iter() {
                // Skip id and element_id fields
                if key != "id" && key != "element_id" {
                    new_obj.insert(key.clone(), remove_ids(val));
                }
            }
            Value::Object(new_obj)
        }
        _ => value.clone(),
    }
}

/// Preprocess UI tree by removing volatile fields (id, element_id)
/// Port of Python's preprocess_tree() function from sequential_processor.py
pub fn preprocess_tree(json_string: &str) -> Result<String, String> {
    // Parse JSON with lenient parsing (similar to Python's strict=False)
    let tree: Value = serde_json::from_str(json_string)
        .map_err(|e| format!("Failed to parse UI tree JSON: {e}"))?;

    let cleaned_tree = remove_ids(&tree);

    serde_json::to_string_pretty(&cleaned_tree)
        .map_err(|e| format!("Failed to serialize cleaned tree: {e}"))
}

/// Remove IDs and bounds from compact YAML format for cleaner diffs
/// Compact YAML format: - [Button] Submit #id123 (bounds: [10,20,100,30], focusable)
/// After removal: - [Button] Submit (focusable)
pub fn remove_ids_and_bounds_from_compact_yaml(yaml_str: &str) -> String {
    // Remove #id patterns (e.g., #12345, #abc-def-123)
    // This regex matches: space + # + word characters (letters, numbers, hyphens)
    let id_re = Regex::new(r" #[\w\-]+").unwrap();
    let result = id_re.replace_all(yaml_str, "");

    // Remove bounds patterns: "bounds: [x,y,w,h]" with optional trailing comma/space
    // Matches: "bounds: [123,456,789,100]" or "bounds: [123,456,789,100], "
    let bounds_re = Regex::new(r"bounds: \[[^\]]+\],?\s*").unwrap();
    bounds_re.replace_all(&result, "").to_string()
}

/// Compute UI tree diff using line-based diffing
/// Port of Python's simple_ui_tree_diff() function from sequential_processor.py
///
/// Supports both JSON and compact YAML formats:
/// - JSON: Parses and removes id/element_id fields
/// - Compact YAML: Uses regex to remove #id patterns and bounds
pub fn simple_ui_tree_diff(
    old_tree_str: &str,
    new_tree_str: &str,
) -> Result<Option<String>, String> {
    // Detect format based on content
    let is_yaml = old_tree_str.trim_start().starts_with("- [");

    // Preprocess both trees to remove volatile fields (IDs and bounds)
    let (old_processed, new_processed) = if is_yaml {
        // Compact YAML format - remove #id patterns and bounds with regex
        (
            remove_ids_and_bounds_from_compact_yaml(old_tree_str),
            remove_ids_and_bounds_from_compact_yaml(new_tree_str),
        )
    } else {
        // JSON format - parse and remove id fields
        (
            preprocess_tree(old_tree_str)?,
            preprocess_tree(new_tree_str)?,
        )
    };

    // Compute line-based diff using similar crate (Rust equivalent of difflib.ndiff)
    let diff = TextDiff::from_lines(&old_processed, &new_processed);

    let mut changed_lines = Vec::new();

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Delete => {
                changed_lines.push(format!("- {}", change.value().trim_end()));
            }
            ChangeTag::Insert => {
                changed_lines.push(format!("+ {}", change.value().trim_end()));
            }
            ChangeTag::Equal => {
                // Skip unchanged lines (equivalent to Python filtering for '+ ' or '- ')
            }
        }
    }

    if changed_lines.is_empty() {
        Ok(None)
    } else {
        Ok(Some(changed_lines.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_remove_ids() {
        let input = json!({
            "role": "Button",
            "name": "Submit",
            "id": "12345",
            "element_id": "abc-def",
            "children": [
                {
                    "role": "Text",
                    "id": "67890",
                    "value": "Click me"
                }
            ]
        });

        let expected = json!({
            "role": "Button",
            "name": "Submit",
            "children": [
                {
                    "role": "Text",
                    "value": "Click me"
                }
            ]
        });

        assert_eq!(remove_ids(&input), expected);
    }

    #[test]
    fn test_preprocess_tree() {
        let input = r#"{"role":"Button","id":"123","name":"Test"}"#;
        let result = preprocess_tree(input).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();

        assert!(parsed.get("id").is_none());
        assert_eq!(parsed.get("role").unwrap(), "Button");
        assert_eq!(parsed.get("name").unwrap(), "Test");
    }

    #[test]
    fn test_simple_ui_tree_diff_no_changes() {
        let tree1 = r#"{"role":"Window","name":"Test","id":"123"}"#;
        let tree2 = r#"{"role":"Window","name":"Test","id":"456"}"#; // Different ID but same after preprocessing

        let diff = simple_ui_tree_diff(tree1, tree2).unwrap();
        assert!(diff.is_none()); // IDs are stripped, so no diff
    }

    #[test]
    fn test_simple_ui_tree_diff_with_changes() {
        let tree1 = r#"{"role":"Window","name":"Test1","id":"123"}"#;
        let tree2 = r#"{"role":"Window","name":"Test2","id":"456"}"#;

        let diff = simple_ui_tree_diff(tree1, tree2).unwrap();
        assert!(diff.is_some());
        let diff_text = diff.unwrap();
        assert!(diff_text.contains("Test1"));
        assert!(diff_text.contains("Test2"));
    }

    #[test]
    fn test_remove_ids_and_bounds_from_compact_yaml() {
        let input =
            "- [Button] Submit #id123 (bounds: [10,20,100,30], focusable)\n  - [Text] Label #id456";
        let expected = "- [Button] Submit (focusable)\n  - [Text] Label";

        let result = remove_ids_and_bounds_from_compact_yaml(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_remove_bounds_only() {
        let input = "- [Group] Comment (bounds: [26,472,617,367], focusable)";
        let expected = "- [Group] Comment (focusable)";

        let result = remove_ids_and_bounds_from_compact_yaml(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_simple_ui_tree_diff_yaml_no_changes() {
        let tree1 = "- [Window] Test #id123\n  - [Button] Click #id456";
        let tree2 = "- [Window] Test #id789\n  - [Button] Click #id000";

        let diff = simple_ui_tree_diff(tree1, tree2).unwrap();
        assert!(diff.is_none()); // IDs are stripped, so no diff
    }

    #[test]
    fn test_simple_ui_tree_diff_yaml_bounds_change_no_diff() {
        // Same structure, only bounds changed (element moved down 118px)
        let tree1 = "- [Group] Comment from flappy-goose (bounds: [26,472,617,367], focusable)\n  - [Button] Reply (bounds: [128,961,82,34], focusable)";
        let tree2 = "- [Group] Comment from flappy-goose (bounds: [26,472,617,485], focusable)\n  - [Button] Reply (bounds: [128,1079,82,34], focusable)";

        let diff = simple_ui_tree_diff(tree1, tree2).unwrap();
        assert!(
            diff.is_none(),
            "Bounds-only changes should not produce a diff"
        );
    }

    #[test]
    fn test_simple_ui_tree_diff_yaml_with_changes() {
        let tree1 = "- [Window] Test1 #id123\n  - [Button] Click #id456";
        let tree2 = "- [Window] Test2 #id789\n  - [Button] Submit #id000";

        let diff = simple_ui_tree_diff(tree1, tree2).unwrap();
        assert!(diff.is_some());
        let diff_text = diff.unwrap();
        assert!(diff_text.contains("Test1"));
        assert!(diff_text.contains("Test2"));
        assert!(diff_text.contains("Click"));
        assert!(diff_text.contains("Submit"));
    }
}
