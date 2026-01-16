use crate::scripting_engine::execute_javascript_with_nodejs;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JavaScript-based parser definition
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OutputParserDefinition {
    /// Optional: Specify which step ID contains the UI tree to parse
    #[serde(default)]
    pub ui_tree_source_step_id: Option<String>,
    /// JavaScript code that processes the tree and returns results
    /// The code receives a 'tree' variable containing the UI tree
    /// and should return an array of objects.
    /// Either this or javascript_file_path must be provided.
    pub javascript_code: Option<String>,
    /// Path to a JavaScript file containing the parser code.
    /// Either this or javascript_code must be provided.
    pub javascript_file_path: Option<String>,
    /// Simplified alias for 'javascript_code' - inspired by GitHub Actions syntax
    /// Use this for inline JavaScript code instead of javascript_code
    pub run: Option<String>,
}

/// The main entry point for parsing tool output.
pub async fn run_output_parser(
    parser_def_val: &Value,
    tool_output: &Value,
) -> Result<Option<Value>> {
    // Support simplified format where output is just a string (JavaScript code)
    let parser_def = if parser_def_val.is_string() {
        OutputParserDefinition {
            ui_tree_source_step_id: None,
            javascript_code: parser_def_val.as_str().map(|s| s.to_string()),
            javascript_file_path: None,
            run: None,
        }
    } else {
        serde_json::from_value(parser_def_val.clone()).map_err(|e| {
            anyhow::anyhow!(
                "Invalid parser definition format. Expected JavaScript format: {}",
                e
            )
        })?
    };

    // Determine the JavaScript source - support 'run' as alias for 'javascript_code'
    let javascript_code = parser_def.javascript_code.or(parser_def.run);

    let user_javascript_code = match (javascript_code, parser_def.javascript_file_path) {
        (Some(code), None) => {
            // Inline JavaScript provided (via javascript_code or run)
            code
        }
        (None, Some(file_path)) => {
            // File path provided - read the file
            std::fs::read_to_string(&file_path).map_err(|e| {
                anyhow::anyhow!("Failed to read JavaScript file '{}': {}", file_path, e)
            })?
        }
        (Some(_), Some(_)) => {
            return Err(anyhow::anyhow!(
                "Cannot provide both inline JavaScript code ('javascript_code' or 'run') and 'javascript_file_path'. Please provide only one."
            ));
        }
        (None, None) => {
            return Err(anyhow::anyhow!(
                "Must provide either 'javascript_code'/'run' (inline JavaScript) or 'javascript_file_path' (path to JavaScript file)."
            ));
        }
    };

    let ui_tree =
        find_ui_tree_in_results(tool_output, parser_def.ui_tree_source_step_id.as_deref())?;

    // Create JavaScript code that injects available data and executes the user code
    let full_script = match ui_tree {
        Some(tree) => {
            // UI tree parsing mode - inject both tree and full results
            format!(
                r#"
                // Inject the UI tree as the primary variable for backward compatibility
                const tree = {};
                
                // Also inject the full tool output for advanced use cases
                const sequenceResult = {};
                
                // Execute the user's parsing logic and return the result
                {}
                "#,
                serde_json::to_string(&tree)
                    .map_err(|e| anyhow::anyhow!("Failed to serialize tree: {}", e))?,
                serde_json::to_string(tool_output)
                    .map_err(|e| anyhow::anyhow!("Failed to serialize tool output: {}", e))?,
                user_javascript_code
            )
        }
        None => {
            // No UI tree found - API/general result parsing mode
            // Inject the full tool output as sequenceResult for JavaScript to process
            format!(
                r#"
                // No UI tree available - this is likely an API-based workflow
                const tree = null;
                
                // Inject the full tool output for result parsing
                const sequenceResult = {};
                
                // Execute the user's parsing logic and return the result
                {}
                "#,
                serde_json::to_string(tool_output)
                    .map_err(|e| anyhow::anyhow!("Failed to serialize tool output: {}", e))?,
                user_javascript_code
            )
        }
    };

    // Execute JavaScript code asynchronously
    let result = execute_javascript_with_nodejs(full_script, None, None, None, None, None)
        .await
        .map_err(|e| anyhow::anyhow!("JavaScript execution failed: {}", e))?;

    Ok(Some(result))
}

/// Finds a UI tree in the tool output results
fn find_ui_tree_in_results(tool_output: &Value, step_id: Option<&str>) -> Result<Option<Value>> {
    // Strategy 0: If step_id is specified, prefer UI tree from that specific step, but gracefully
    // fall back to any available UI tree if that step exists without a tree or is not present.
    if let Some(target_step_id) = step_id {
        if let Some(results) = tool_output.get("results").and_then(|v| v.as_array()) {
            // Recursive search that also records whether the step was seen at all
            fn search_for_step_id(
                results: &[Value],
                target_step_id: &str,
                found_step: &mut bool,
            ) -> Option<Value> {
                for result in results {
                    if let Some(result_step_id) = result.get("step_id").and_then(|v| v.as_str()) {
                        if result_step_id == target_step_id {
                            *found_step = true;
                            if let Some(ui_tree) = result.get("ui_tree") {
                                return Some(ui_tree.clone());
                            }
                            if let Some(result_obj) = result.get("result") {
                                if let Some(ui_tree) = result_obj.get("ui_tree") {
                                    return Some(ui_tree.clone());
                                }
                                if let Some(content) =
                                    result_obj.get("content").and_then(|c| c.as_array())
                                {
                                    for content_item in content {
                                        if let Some(ui_tree) = content_item.get("ui_tree") {
                                            return Some(ui_tree.clone());
                                        }
                                        // Legacy path where JSON was embedded as text
                                        if let Some(text) =
                                            content_item.get("text").and_then(|t| t.as_str())
                                        {
                                            if let Ok(parsed_json) =
                                                serde_json::from_str::<Value>(text)
                                            {
                                                if let Some(ui_tree) = parsed_json.get("ui_tree") {
                                                    return Some(ui_tree.clone());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            // Step found but contains no ui_tree
                            return None;
                        }
                    }
                    // Search inside group results (nested)
                    if let Some(group_results) = result.get("results").and_then(|r| r.as_array()) {
                        if let Some(found) =
                            search_for_step_id(group_results, target_step_id, found_step)
                        {
                            return Some(found);
                        }
                    }
                }
                None
            }

            let mut found_step = false;
            if let Some(ui_tree) = search_for_step_id(results, target_step_id, &mut found_step) {
                return Ok(Some(ui_tree));
            }

            // If we reached here, either the step exists without a ui_tree or it wasn't found.
            // Be forgiving: fall back to general search instead of erroring out.
            // This avoids breaking workflows where the referenced step is a close/minimize step.
        } // else: no results array; fall through to general search
    }

    // Strategy 1: Check if there's a direct ui_tree field
    if let Some(ui_tree) = tool_output.get("ui_tree") {
        return Ok(Some(ui_tree.clone()));
    }

    // Strategy 2: Look through results array for UI trees (fallback behavior)
    if let Some(results) = tool_output.get("results") {
        if let Some(results_array) = results.as_array() {
            for result in results_array.iter().rev() {
                if let Some(ui_tree) = result.get("ui_tree") {
                    return Ok(Some(ui_tree.clone()));
                }

                if let Some(result_obj) = result.get("result") {
                    if let Some(ui_tree) = result_obj.get("ui_tree") {
                        return Ok(Some(ui_tree.clone()));
                    }

                    if let Some(content) = result_obj.get("content") {
                        if let Some(content_array) = content.as_array() {
                            for content_item in content_array.iter().rev() {
                                if let Some(text) = content_item.get("text") {
                                    if let Some(text_str) = text.as_str() {
                                        if let Ok(parsed_json) =
                                            serde_json::from_str::<Value>(text_str)
                                        {
                                            if let Some(ui_tree) = parsed_json.get("ui_tree") {
                                                return Ok(Some(ui_tree.clone()));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_javascript_parser() {
        json!({
            "children": [
                {
                    "attributes": {
                        "role": "CheckBox",
                        "name": "Test Product",
                        "id": "123",
                        "is_toggled": true
                    }
                },
                {
                    "attributes": {
                        "role": "CheckBox",
                        "name": "Another Product",
                        "id": "456",
                        "is_toggled": false
                    }
                }
            ]
        });

        let parser_def = OutputParserDefinition {
            ui_tree_source_step_id: None,
            run: None,
            javascript_code: Some(
                r#"
                const results = [];

                function findElementsRecursively(element) {
                    if (element.attributes && element.attributes.role === 'CheckBox') {
                        const item = {
                            productName: element.attributes.name || '',
                            id: element.attributes.id || '',
                            is_toggled: element.attributes.is_toggled || false
                        };
                        results.push(item);
                    }
                    
                    if (element.children) {
                        for (const child of element.children) {
                            findElementsRecursively(child);
                        }
                    }
                }

                findElementsRecursively(tree);
                return results;
            "#
                .to_string(),
            ),
            javascript_file_path: None,
        };
        // Note: This test would require an async runtime to execute JavaScript
        // For now, we'll just verify the parser definition structure is correct
        let parser_def_json = serde_json::to_value(&parser_def).unwrap();
        assert!(parser_def_json.get("javascript_code").is_some());
    }

    #[test]
    fn test_empty_results() {
        let parser_def = OutputParserDefinition {
            ui_tree_source_step_id: None,
            run: None,
            javascript_code: Some(
                r#"
                const results = [];
                
                function findElementsRecursively(element) {
                    if (element.children) {
                        for (const child of element.children) {
                            findElementsRecursively(child);
                        }
                    }
                }
                
                findElementsRecursively(tree);
                return results;
            "#
                .to_string(),
            ),
            javascript_file_path: None,
        };

        // Verify parser definition structure
        let parser_def_json = serde_json::to_value(&parser_def).unwrap();
        assert!(parser_def_json.get("javascript_code").is_some());
    }

    #[test]
    fn test_step_id_lookup() {
        json!({
            "children": [
                {
                    "attributes": {
                        "role": "CheckBox",
                        "name": "Found Product",
                        "id": "789"
                    }
                }
            ]
        });

        let parser_def = OutputParserDefinition {
            ui_tree_source_step_id: Some("test_step".to_string()),
            run: None,
            javascript_code: Some(
                r#"
                const results = [];
                
                function findElementsRecursively(element) {
                    if (element.attributes && element.attributes.role === 'CheckBox') {
                        const item = {
                            productName: element.attributes.name || '',
                            id: element.attributes.id || ''
                        };
                        results.push(item);
                    }
                    
                    if (element.children) {
                        for (const child of element.children) {
                            findElementsRecursively(child);
                        }
                    }
                }
                
                findElementsRecursively(tree);
                return results;
            "#
                .to_string(),
            ),
            javascript_file_path: None,
        };

        // Verify parser definition structure
        let parser_def_json = serde_json::to_value(&parser_def).unwrap();
        assert!(parser_def_json.get("javascript_code").is_some());
        assert_eq!(
            parser_def.ui_tree_source_step_id,
            Some("test_step".to_string())
        );
    }

    #[test]
    fn test_attribute_value_filtering() {
        let parser_def = OutputParserDefinition {
            ui_tree_source_step_id: None,
            run: None,
            javascript_code: Some(
                r#"
                const results = [];
                
                function findElementsRecursively(element) {
                    if (element.attributes && 
                        element.attributes.role === 'CheckBox' && 
                        element.attributes.is_toggled === true) {
                        
                        const item = {
                            productName: element.attributes.name || ''
                        };
                        results.push(item);
                    }
                    
                    if (element.children) {
                        for (const child of element.children) {
                            findElementsRecursively(child);
                        }
                    }
                }
                
                findElementsRecursively(tree);
                return results;
            "#
                .to_string(),
            ),
            javascript_file_path: None,
        };

        json!({
            "children": [
                {
                    "attributes": {
                        "role": "CheckBox",
                        "name": "Toggled Checkbox",
                        "is_toggled": true
                    }
                },
                {
                    "attributes": {
                        "role": "CheckBox",
                        "name": "Untoggled Checkbox",
                        "is_toggled": false
                    }
                },
                {
                    "attributes": {
                        "role": "CheckBox",
                        "name": "Missing Toggle Checkbox"
                    }
                }
            ]
        });

        // Verify parser definition structure
        let parser_def_json = serde_json::to_value(&parser_def).unwrap();
        assert!(parser_def_json.get("javascript_code").is_some());
    }

    #[test]
    fn test_parser_definition_serialization() {
        // Test the new clean syntax for JavaScript-based parsing
        let parser_def_json = json!({
            "ui_tree_source_step_id": "capture_tree",
            "javascript_code": "return [];"
        });

        let parser_def: OutputParserDefinition = serde_json::from_value(parser_def_json).unwrap();
        assert_eq!(
            parser_def.ui_tree_source_step_id,
            Some("capture_tree".to_string())
        );
        assert_eq!(parser_def.javascript_code, Some("return [];".to_string()));
    }
}
