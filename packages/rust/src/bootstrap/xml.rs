//! XML parsing utilities for elizaOS.
//!
//! This module provides utilities for parsing XML responses from LLM models.

use std::collections::HashMap;

/// Parse key-value pairs from an XML response
pub fn parse_key_value_xml(xml: &str) -> Option<HashMap<String, String>> {
    let mut result = HashMap::new();

    // Find the response block
    let start_tag = "<response>";
    let end_tag = "</response>";

    let response_content = if let Some(start) = xml.find(start_tag) {
        let content_start = start + start_tag.len();
        if let Some(end) = xml[content_start..].find(end_tag) {
            &xml[content_start..content_start + end]
        } else {
            xml
        }
    } else {
        xml
    };

    // Parse individual tags
    let mut pos = 0;
    while pos < response_content.len() {
        // Find opening tag
        if let Some(tag_start) = response_content[pos..].find('<') {
            let tag_start = pos + tag_start;

            // Skip closing tags and special tags
            if response_content[tag_start + 1..].starts_with('/')
                || response_content[tag_start + 1..].starts_with('!')
                || response_content[tag_start + 1..].starts_with('?')
            {
                pos = tag_start + 1;
                continue;
            }

            // Find tag name end
            if let Some(tag_end) = response_content[tag_start..].find('>') {
                let tag_end = tag_start + tag_end;
                let tag_name = &response_content[tag_start + 1..tag_end];

                // Skip if tag has attributes (for simplicity)
                let tag_name = tag_name.split_whitespace().next().unwrap_or(tag_name);

                // Find closing tag
                let close_tag = format!("</{}>", tag_name);
                if let Some(close_start) = response_content[tag_end + 1..].find(&close_tag) {
                    let close_start = tag_end + 1 + close_start;
                    let value = response_content[tag_end + 1..close_start].trim();
                    result.insert(tag_name.to_string(), value.to_string());
                    pos = close_start + close_tag.len();
                    continue;
                }
            }
            pos = tag_start + 1;
        } else {
            break;
        }
    }

    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_xml() {
        let xml = r#"
            <response>
                <thought>Thinking about this</thought>
                <text>Hello world</text>
            </response>
        "#;

        let result = parse_key_value_xml(xml).unwrap();
        assert_eq!(result.get("thought"), Some(&"Thinking about this".to_string()));
        assert_eq!(result.get("text"), Some(&"Hello world".to_string()));
    }

    #[test]
    fn test_parse_without_response_wrapper() {
        let xml = r#"
            <thought>Just thinking</thought>
            <selected_id>42</selected_id>
        "#;

        let result = parse_key_value_xml(xml).unwrap();
        assert_eq!(result.get("thought"), Some(&"Just thinking".to_string()));
        assert_eq!(result.get("selected_id"), Some(&"42".to_string()));
    }

    #[test]
    fn test_parse_empty_returns_none() {
        let xml = "no xml here";
        assert!(parse_key_value_xml(xml).is_none());
    }
}

