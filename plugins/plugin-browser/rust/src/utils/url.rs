use regex::Regex;

pub fn extract_url(text: &str) -> Option<String> {
    let quoted_re = Regex::new(r#"["']([^"']+)["']"#).unwrap();
    if let Some(caps) = quoted_re.captures(text) {
        let url = &caps[1];
        if url.starts_with("http") || url.contains('.') {
            return Some(url.to_string());
        }
    }

    let url_re = Regex::new(r"(https?://[^\s]+)").unwrap();
    if let Some(caps) = url_re.captures(text) {
        return Some(caps[1].to_string());
    }

    let domain_re = Regex::new(
        r"(?i)(?:go to|navigate to|open|visit)\s+([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,})",
    )
    .unwrap();
    if let Some(caps) = domain_re.captures(text) {
        return Some(format!("https://{}", &caps[1]));
    }

    None
}

pub fn parse_click_target(text: &str) -> String {
    let re = Regex::new(r"(?i)click (?:on |the )?(.+)$").unwrap();
    match re.captures(text) {
        Some(caps) => caps[1].to_string(),
        None => "element".to_string(),
    }
}

pub fn parse_type_action(text: &str) -> (String, String) {
    let text_re = Regex::new(r#"["']([^"']+)["']"#).unwrap();
    let text_to_type = text_re
        .captures(text)
        .map(|c| c[1].to_string())
        .unwrap_or_default();

    let field_re = Regex::new(r"(?i)(?:in|into) (?:the )?(.+)$").unwrap();
    let field = field_re
        .captures(text)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "input field".to_string());

    (text_to_type, field)
}

pub fn parse_select_action(text: &str) -> (String, String) {
    let option_re = Regex::new(r#"["']([^"']+)["']"#).unwrap();
    let option = option_re
        .captures(text)
        .map(|c| c[1].to_string())
        .unwrap_or_default();

    let dropdown_re = Regex::new(r"(?i)from (?:the )?(.+)$").unwrap();
    let dropdown = dropdown_re
        .captures(text)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "dropdown".to_string());

    (option, dropdown)
}

pub fn parse_extract_instruction(text: &str) -> String {
    let re =
        Regex::new(r"(?i)(?:extract|get|find|scrape|read) (?:the )?(.+?)(?:\s+from|\s*$)").unwrap();
    match re.captures(text) {
        Some(caps) => caps[1].to_string(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_url() {
        assert_eq!(
            extract_url("Go to google.com"),
            Some("https://google.com".to_string())
        );
        assert_eq!(
            extract_url("Navigate to https://example.com"),
            Some("https://example.com".to_string())
        );
        assert_eq!(
            extract_url("Open 'https://test.com'"),
            Some("https://test.com".to_string())
        );
    }

    #[test]
    fn test_parse_click_target() {
        assert_eq!(
            parse_click_target("click on the search button"),
            "the search button"
        );
        assert_eq!(parse_click_target("Click the submit"), "submit");
    }

    #[test]
    fn test_parse_type_action() {
        let (text, field) = parse_type_action("Type 'hello' in the search box");
        assert_eq!(text, "hello");
        assert_eq!(field, "search box");
    }
}
