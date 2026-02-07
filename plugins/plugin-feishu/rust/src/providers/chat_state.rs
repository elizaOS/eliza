use super::{FeishuProvider, ProviderContext};

/// Provider that supplies Feishu chat state information.
pub struct ChatStateProvider;

impl FeishuProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "FEISHU_CHAT_STATE"
    }

    fn description(&self) -> &'static str {
        "Provides Feishu chat context and state information"
    }

    fn get(&self, context: &ProviderContext) -> Option<String> {
        // Only provide state for Feishu messages
        let source = context.message.get("source").and_then(|v| v.as_str());
        if source != Some("feishu") {
            return None;
        }

        let chat_id = context.chat_id.as_ref()?;

        let mut state_info = vec![
            "Platform: Feishu/Lark".to_string(),
            format!("Chat ID: {}", chat_id),
        ];

        if let Some(ref message_id) = context.message_id {
            state_info.push(format!("Message ID: {}", message_id));
        }

        // Add any additional state information
        if let Some(chat_type) = context.state.get("feishu_chat_type").and_then(|v| v.as_str()) {
            state_info.push(format!("Chat Type: {}", chat_type));
        }

        if let Some(chat_name) = context.state.get("feishu_chat_name").and_then(|v| v.as_str()) {
            state_info.push(format!("Chat Name: {}", chat_name));
        }

        Some(state_info.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_name() {
        let provider = ChatStateProvider;
        assert_eq!(provider.name(), "FEISHU_CHAT_STATE");
    }

    #[test]
    fn test_get_feishu_source() {
        let provider = ChatStateProvider;

        let context = ProviderContext {
            message: serde_json::json!({
                "source": "feishu"
            }),
            chat_id: Some("oc_test123".to_string()),
            message_id: Some("msg_456".to_string()),
            state: serde_json::json!({}),
        };

        let result = provider.get(&context);
        assert!(result.is_some());

        let text = result.unwrap();
        assert!(text.contains("Feishu/Lark"));
        assert!(text.contains("oc_test123"));
        assert!(text.contains("msg_456"));
    }

    #[test]
    fn test_get_non_feishu_source() {
        let provider = ChatStateProvider;

        let context = ProviderContext {
            message: serde_json::json!({
                "source": "telegram"
            }),
            chat_id: Some("oc_test123".to_string()),
            message_id: None,
            state: serde_json::json!({}),
        };

        let result = provider.get(&context);
        assert!(result.is_none());
    }

    #[test]
    fn test_get_no_chat_id() {
        let provider = ChatStateProvider;

        let context = ProviderContext {
            message: serde_json::json!({
                "source": "feishu"
            }),
            chat_id: None,
            message_id: None,
            state: serde_json::json!({}),
        };

        let result = provider.get(&context);
        assert!(result.is_none());
    }
}
