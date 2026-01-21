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

/// Extract direct child XML elements from a string.
///
/// This is a small, non-validating parser intended for the simple XML produced by the prompts.
/// It supports nested tags with the same name by tracking depth.
fn extract_xml_children(xml: &str) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let bytes = xml.as_bytes();
    let mut i: usize = 0;
    while i < bytes.len() {
        // Find next '<'
        let open_idx = match xml[i..].find('<') {
            Some(off) => i + off,
            None => break,
        };

        // Skip closing tags and comments/decls
        if xml[open_idx..].starts_with("</")
            || xml[open_idx..].starts_with("<!--")
            || xml[open_idx..].starts_with("<?")
        {
            i = open_idx + 1;
            continue;
        }

        // Parse tag name
        let mut j = open_idx + 1;
        let mut tag = String::new();
        while j < bytes.len() {
            let ch = bytes[j] as char;
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                tag.push(ch);
                j += 1;
            } else {
                break;
            }
        }
        if tag.is_empty() {
            i = open_idx + 1;
            continue;
        }

        // Find end of start tag
        let start_tag_end = match xml[j..].find('>') {
            Some(off) => j + off,
            None => break,
        };
        let start_tag_text = &xml[open_idx..=start_tag_end];
        // Self-closing
        if start_tag_text.trim_end().ends_with("/>") {
            i = start_tag_end + 1;
            continue;
        }

        let close_seq = format!("</{}>", tag);
        let mut depth: i32 = 1;
        let mut search_start = start_tag_end + 1;
        while depth > 0 && search_start < bytes.len() {
            let next_open = xml[search_start..]
                .find(&format!("<{}", tag))
                .map(|off| search_start + off);
            let next_close = match xml[search_start..].find(&close_seq) {
                Some(off) => search_start + off,
                None => break,
            };

            if let Some(no) = next_open {
                if no < next_close {
                    // Check if the nested open is self-closing
                    let nested_end = match xml[no..].find('>') {
                        Some(off) => no + off,
                        None => break,
                    };
                    let nested_text = &xml[no..=nested_end];
                    if !nested_text.trim_end().ends_with("/>") {
                        depth += 1;
                    }
                    search_start = nested_end + 1;
                    continue;
                }
            }

            // close tag
            depth -= 1;
            search_start = next_close + close_seq.len();
        }

        if depth != 0 {
            i = start_tag_end + 1;
            continue;
        }

        let close_idx = search_start - close_seq.len();
        let inner = xml[start_tag_end + 1..close_idx].trim().to_string();
        pairs.push((tag, inner));
        i = search_start;
    }

    pairs
}

/// Parse a `<params>...</params>` block (or its inner XML) into per-action parameter maps.
///
/// Returns a map keyed by UPPERCASE action name, where each value is a map of parameter name
/// to JSON string value.
pub fn parse_action_params(
    params_xml: &str,
) -> HashMap<String, HashMap<String, serde_json::Value>> {
    let mut out: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    let trimmed = params_xml.trim();
    if trimmed.is_empty() {
        return out;
    }

    // Accept either "<params>...</params>" or already-inner XML.
    let inner = if let Some(start) = trimmed.find("<params>") {
        let content_start = start + "<params>".len();
        if let Some(end_off) = trimmed[content_start..].find("</params>") {
            &trimmed[content_start..content_start + end_off]
        } else {
            trimmed
        }
    } else {
        trimmed
    };

    for (action_name, action_body) in extract_xml_children(inner) {
        let mut param_map: HashMap<String, serde_json::Value> = HashMap::new();
        for (param_name, param_val) in extract_xml_children(&action_body) {
            if !param_name.trim().is_empty() {
                param_map.insert(param_name, serde_json::Value::String(param_val));
            }
        }
        if !param_map.is_empty() {
            out.insert(action_name.to_uppercase(), param_map);
        }
    }
    out
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
        assert_eq!(
            result.get("thought"),
            Some(&"Thinking about this".to_string())
        );
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

    #[test]
    fn test_parse_action_params_inner_xml() {
        let xml = r#"
          <REPLY>
            <foo>bar</foo>
          </REPLY>
          <SEND_MESSAGE>
            <roomId>123</roomId>
            <text>Hello</text>
          </SEND_MESSAGE>
        "#;
        let parsed = parse_action_params(xml);
        assert_eq!(
            parsed
                .get("REPLY")
                .and_then(|m| m.get("foo"))
                .and_then(|v| v.as_str()),
            Some("bar")
        );
        assert_eq!(
            parsed
                .get("SEND_MESSAGE")
                .and_then(|m| m.get("text"))
                .and_then(|v| v.as_str()),
            Some("Hello")
        );
    }

    #[test]
    fn test_parse_action_params_wrapped() {
        let xml = r#"
          <params>
            <ACTION1><a>1</a></ACTION1>
          </params>
        "#;
        let parsed = parse_action_params(xml);
        assert_eq!(
            parsed
                .get("ACTION1")
                .and_then(|m| m.get("a"))
                .and_then(|v| v.as_str()),
            Some("1")
        );
    }
}
