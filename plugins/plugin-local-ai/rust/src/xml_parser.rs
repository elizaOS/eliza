#![allow(missing_docs)]

use regex::Regex;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub enum XmlValue {
    String(String),
    Bool(bool),
    List(Vec<String>),
}

impl XmlValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            XmlValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            XmlValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[String]> {
        match self {
            XmlValue::List(l) => Some(l),
            _ => None,
        }
    }

    pub fn to_string_value(&self) -> String {
        match self {
            XmlValue::String(s) => s.clone(),
            XmlValue::Bool(b) => b.to_string(),
            XmlValue::List(l) => l.join(", "),
        }
    }
}

pub fn extract_xml_tag(text: &str, tag_name: &str) -> Option<String> {
    if text.is_empty() || tag_name.is_empty() {
        return None;
    }

    let cdata_pattern = format!(r"<{}[^>]*>\s*<!\[CDATA\[", tag_name);
    if let Ok(cdata_regex) = Regex::new(&cdata_pattern) {
        if let Some(m) = cdata_regex.find(text) {
            let content_start = m.end();
            if let Some(cdata_end) = text[content_start..].find("]]>") {
                let content = &text[content_start..content_start + cdata_end];
                return Some(content.to_string());
            }
        }
    }

    let start_tag_pattern = format!("<{}", tag_name);
    let end_tag = format!("</{}>", tag_name);

    let start_idx = text.find(&start_tag_pattern)?;
    let start_tag_end = text[start_idx..].find('>')? + start_idx;

    if text[start_idx..=start_tag_end].contains("/>") {
        return Some(String::new());
    }

    let content_start = start_tag_end + 1;

    let mut depth = 1;
    let mut search_start = content_start;

    while depth > 0 && search_start < text.len() {
        let next_open = text[search_start..].find(&start_tag_pattern);
        let next_close = text[search_start..].find(&end_tag);

        let next_close = match next_close {
            Some(idx) => idx + search_start,
            None => break,
        };

        if let Some(open_offset) = next_open {
            let next_open_abs = open_offset + search_start;
            if next_open_abs < next_close {
                if let Some(nested_end_offset) = text[next_open_abs..].find('>') {
                    let nested_end_idx = next_open_abs + nested_end_offset;
                    let nested_tag_content = &text[next_open_abs..=nested_end_idx];
                    if !nested_tag_content.contains("/>") {
                        depth += 1;
                    }
                    search_start = nested_end_idx + 1;
                } else {
                    search_start = next_open_abs + 1;
                }
                continue;
            }
        }

        depth -= 1;
        if depth == 0 {
            let content = &text[content_start..next_close];
            return Some(unescape_xml(content.trim()));
        }
        search_start = next_close + end_tag.len();
    }

    None
}

pub fn unescape_xml(text: &str) -> String {
    let mut result = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");

    if let Ok(decimal_re) = Regex::new(r"&#(\d+);") {
        result = decimal_re
            .replace_all(&result, |caps: &regex::Captures| {
                caps.get(1)
                    .and_then(|m| m.as_str().parse::<u32>().ok())
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| caps[0].to_string())
            })
            .to_string();
    }

    if let Ok(hex_re) = Regex::new(r"&#x([0-9a-fA-F]+);") {
        result = hex_re
            .replace_all(&result, |caps: &regex::Captures| {
                caps.get(1)
                    .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| caps[0].to_string())
            })
            .to_string();
    }

    result
}

pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn wrap_in_cdata(text: &str) -> String {
    if text.contains('<') || text.contains('>') || text.contains('&') {
        let escaped_text = text.replace("]]>", "]]]]><![CDATA[>");
        format!("<![CDATA[{}]]>", escaped_text)
    } else {
        text.to_string()
    }
}

pub fn parse_simple_xml(text: &str) -> Option<HashMap<String, XmlValue>> {
    if text.is_empty() {
        return None;
    }

    let mut xml_content = extract_xml_tag(text, "response");

    if xml_content.is_none() {
        for wrapper in &["result", "output", "data", "answer"] {
            xml_content = extract_xml_tag(text, wrapper);
            if xml_content.is_some() {
                break;
            }
        }
    }

    let xml_content = match xml_content {
        Some(content) => content,
        None => {
            if !text.contains('<') || !text.contains('>') {
                return None;
            }
            text.to_string()
        }
    };

    let mut result = HashMap::new();
    let mut found_tags = HashSet::new();

    let tag_pattern = Regex::new(r"<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>").ok()?;

    for cap in tag_pattern.captures_iter(&xml_content) {
        let tag_name = cap.get(1)?.as_str();

        if found_tags.contains(tag_name) {
            continue;
        }
        found_tags.insert(tag_name.to_string());

        if let Some(value) = extract_xml_tag(&xml_content, tag_name) {
            let typed_value = match tag_name {
                "actions" | "providers" | "evaluators" => {
                    let items: Vec<String> = value
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    XmlValue::List(items)
                }
                "simple" | "success" | "error" => XmlValue::Bool(value.to_lowercase() == "true"),
                _ => XmlValue::String(value),
            };
            result.insert(tag_name.to_string(), typed_value);
        }
    }

    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

pub fn parse_simple_xml_strings(text: &str) -> Option<HashMap<String, String>> {
    parse_simple_xml(text).map(|map| {
        map.into_iter()
            .map(|(k, v)| (k, v.to_string_value()))
            .collect()
    })
}

pub fn sanitize_for_xml(content: &str) -> String {
    let has_xml_like_syntax = Regex::new(r"<[a-zA-Z]")
        .map(|r| r.is_match(content))
        .unwrap_or(false)
        || content.contains("</");

    if has_xml_like_syntax {
        wrap_in_cdata(content)
    } else {
        escape_xml(content)
    }
}

pub fn build_xml_response(data: &HashMap<String, XmlValue>) -> String {
    let mut parts = vec!["<response>".to_string()];

    for (key, value) in data {
        let content = match value {
            XmlValue::String(s) => sanitize_for_xml(s),
            XmlValue::Bool(b) => b.to_string(),
            XmlValue::List(items) => items.join(", "),
        };
        parts.push(format!("  <{}>{}</{}>", key, content, key));
    }

    parts.push("</response>".to_string());
    parts.join("\n")
}

pub fn build_xml_response_strings(data: &HashMap<String, String>) -> String {
    let mut parts = vec!["<response>".to_string()];

    for (key, value) in data {
        let content = sanitize_for_xml(value);
        parts.push(format!("  <{}>{}</{}>", key, content, key));
    }

    parts.push("</response>".to_string());
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_simple_tag() {
        let xml = "<response><name>John</name></response>";
        assert_eq!(extract_xml_tag(xml, "name"), Some("John".to_string()));
    }

    #[test]
    fn test_extract_cdata() {
        let xml = "<response><code><![CDATA[<script>alert('hello')</script>]]></code></response>";
        assert_eq!(
            extract_xml_tag(xml, "code"),
            Some("<script>alert('hello')</script>".to_string())
        );
    }

    #[test]
    fn test_extract_nested_tags() {
        let xml = "<response><outer><inner>value</inner></outer></response>";
        let outer = extract_xml_tag(xml, "outer").unwrap();
        assert!(outer.contains("<inner>value</inner>"));
    }

    #[test]
    fn test_escape_xml() {
        assert_eq!(escape_xml("<test>"), "&lt;test&gt;");
    }

    #[test]
    fn test_unescape_xml() {
        assert_eq!(unescape_xml("&lt;test&gt;"), "<test>");
    }

    #[test]
    fn test_unescape_numeric_entities() {
        assert_eq!(unescape_xml("&#60;"), "<");
        assert_eq!(unescape_xml("&#62;"), ">");
        assert_eq!(unescape_xml("&#x3C;"), "<");
        assert_eq!(unescape_xml("&#x3E;"), ">");
        assert_eq!(unescape_xml("&#60;test&#62;"), "<test>");
    }

    #[test]
    fn test_wrap_in_cdata() {
        assert_eq!(wrap_in_cdata("<code>"), "<![CDATA[<code>]]>");
        assert_eq!(wrap_in_cdata("plain text"), "plain text");
    }

    #[test]
    fn test_wrap_nested_cdata() {
        assert_eq!(
            wrap_in_cdata("data]]>more"),
            "<![CDATA[data]]]]><![CDATA[>more]]>"
        );
    }

    #[test]
    fn test_parse_simple_xml() {
        let xml = "<response><thought>thinking...</thought><text>Hello world</text></response>";
        let result = parse_simple_xml(xml).unwrap();
        assert_eq!(
            result.get("thought").and_then(|v| v.as_str()),
            Some("thinking...")
        );
        assert_eq!(
            result.get("text").and_then(|v| v.as_str()),
            Some("Hello world")
        );
    }

    #[test]
    fn test_parse_list_fields() {
        let xml = "<response><actions>action1, action2, action3</actions></response>";
        let result = parse_simple_xml(xml).unwrap();
        let actions = result.get("actions").and_then(|v| v.as_list()).unwrap();
        assert_eq!(actions, &["action1", "action2", "action3"]);
    }

    #[test]
    fn test_parse_boolean_fields() {
        let xml = "<response><success>true</success><error>false</error></response>";
        let result = parse_simple_xml(xml).unwrap();
        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(result.get("error").and_then(|v| v.as_bool()), Some(false));
    }

    #[test]
    fn test_self_closing_tag() {
        let xml = "<response><empty/></response>";
        assert_eq!(extract_xml_tag(xml, "empty"), Some("".to_string()));
    }

    #[test]
    fn test_code_in_cdata() {
        let xml = r#"<response>
<code><![CDATA[
function test() {
    if (x < 10 && y > 5) {
        return "<div>" + x + "</div>";
    }
}
]]></code>
</response>"#;
        let code = extract_xml_tag(xml, "code").unwrap();
        assert!(code.contains("if (x < 10 && y > 5)"));
        assert!(code.contains("<div>"));
    }

    #[test]
    fn test_parity_extract() {
        assert_eq!(
            extract_xml_tag("<r><x>Y</x></r>", "x"),
            Some("Y".to_string())
        );
    }

    #[test]
    fn test_parity_escape() {
        assert_eq!(escape_xml("<>&\"'"), "&lt;&gt;&amp;&quot;&apos;");
    }

    #[test]
    fn test_parity_unescape() {
        assert_eq!(unescape_xml("&lt;&gt;&amp;&#60;&#x3E;"), "<>&<>");
    }

    #[test]
    fn test_parity_cdata_wrap() {
        assert_eq!(wrap_in_cdata("<x>"), "<![CDATA[<x>]]>");
    }

    #[test]
    fn test_parity_cdata_nested() {
        assert_eq!(wrap_in_cdata("]]>"), "<![CDATA[]]]]><![CDATA[>]]>");
    }

    #[test]
    fn test_parity_special_fields() {
        let xml = "<response><actions>a1, a2, a3</actions><success>true</success></response>";
        let result = parse_simple_xml(xml).unwrap();

        let actions = result.get("actions").and_then(|v| v.as_list()).unwrap();
        assert_eq!(actions, &["a1", "a2", "a3"]);

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));
    }
}
