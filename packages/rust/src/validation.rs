use crate::types::memory::Memory;

/// Validates if any of the given keywords are present in the recent message history.
///
/// This function checks the current message content and the last 5 messages in the provided
/// list for the presence of any of the provided keywords. The check is case-insensitive.
pub fn validate_action_keywords(
    message: &Memory,
    recent_messages: &[Memory],
    keywords: &[String],
) -> bool {
    if keywords.is_empty() {
        return false;
    }

    let mut relevant_text: Vec<String> = Vec::new();

    // 1. Current message content
    if let Some(text) = &message.content.text {
        relevant_text.push(text.clone());
    }

    // 2. Recent messages (last 5)
    let start_index = if recent_messages.len() > 5 {
        recent_messages.len() - 5
    } else {
        0
    };
    for msg in &recent_messages[start_index..] {
        if let Some(text) = &msg.content.text {
            relevant_text.push(text.clone());
        }
    }

    let combined_text = relevant_text.join("\n").to_lowercase();

    // Check keywords
    for keyword in keywords {
        if combined_text.contains(&keyword.to_lowercase()) {
            return true;
        }
    }

    false
}

/// Validates if any of the recent message history matches the given regex pattern.
///
/// This function checks the current message content and the last 5 messages in the provided
/// list against the provided regex pattern.
pub fn validate_action_regex(
    message: &Memory,
    recent_messages: &[Memory],
    regex_pattern: &str,
) -> bool {
    if regex_pattern.is_empty() {
        return false;
    }

    let regex = match regex::Regex::new(regex_pattern) {
        Ok(r) => r,
        Err(_) => return false,
    };

    let mut relevant_text: Vec<String> = Vec::new();

    // 1. Current message content
    if let Some(text) = &message.content.text {
        relevant_text.push(text.clone());
    }

    // 2. Recent messages (last 5)
    let start_index = if recent_messages.len() > 5 {
        recent_messages.len() - 5
    } else {
        0
    };
    for msg in &recent_messages[start_index..] {
        if let Some(text) = &msg.content.text {
            relevant_text.push(text.clone());
        }
    }

    if relevant_text.is_empty() {
        return false;
    }

    let combined_text = relevant_text.join("\n");
    regex.is_match(&combined_text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::memory::Memory;
    use crate::types::primitives::Content;

    fn create_mock_memory(text: &str) -> Memory {
        Memory {
            id: Default::default(),
            entity_id: Default::default(),
            room_id: Default::default(),
            agent_id: Default::default(),
            content: Content {
                text: Some(text.to_string()),
                ..Default::default()
            },
            created_at: Some(0),
            ..Default::default()
        }
    }

    #[test]
    fn test_validate_action_keywords() {
        let keywords = vec!["transfer".to_string(), "pay".to_string()];

        // 1. Keyword in current message
        let msg = create_mock_memory("I want to transfer sol");
        assert!(validate_action_keywords(&msg, &[], &keywords));

        // 2. Keyword in recent messages
        let msg_empty = create_mock_memory("ok");
        let recent = vec![
            create_mock_memory("hello"),
            create_mock_memory("can you pay me?"),
            create_mock_memory("thanks"),
        ];
        assert!(validate_action_keywords(&msg_empty, &recent, &keywords));

        // 3. No keyword
        let recent_none = vec![create_mock_memory("hello")];
        assert!(!validate_action_keywords(
            &msg_empty,
            &recent_none,
            &keywords
        ));

        // 4. Case insensitive
        let msg_caps = create_mock_memory("TRANSFER NOW");
        assert!(validate_action_keywords(&msg_caps, &[], &keywords));

        // 5. Empty keywords
        assert!(!validate_action_keywords(&msg, &[], &[]));
    }

    #[test]
    fn test_validate_action_regex() {
        let msg = create_mock_memory("I want to transfer 100 sol");
        let regex = r"(?i)transfer \d+ sol";

        // 1. Regex match in current message
        assert!(validate_action_regex(&msg, &[], regex));

        // 2. Regex match in recent messages
        let msg_empty = create_mock_memory("ok");
        let recent = vec![
            create_mock_memory("hello"),
            create_mock_memory("transfer 50 sol"),
        ];
        assert!(validate_action_regex(&msg_empty, &recent, regex));

        // 3. No match
        let recent_none = vec![create_mock_memory("hello")];
        assert!(!validate_action_regex(&msg_empty, &recent_none, regex));

        // 4. Invalid regex (should return false safely)
        assert!(!validate_action_regex(&msg, &[], r"["));

        // 5. Unicode support
        let msg_unicode = create_mock_memory("Transfer 100 €");
        assert!(validate_action_regex(
            &msg_unicode,
            &[],
            r"(?i)transfer \d+ €"
        ));

        // 6. Special characters
        let msg_special = create_mock_memory("Hello (world) [ok]");
        assert!(validate_action_regex(&msg_special, &[], r"\(world\)"));

        // 7. Empty input
        assert!(!validate_action_regex(&msg, &[], ""));
    }
}
