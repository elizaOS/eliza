use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn position(&self) -> i32;
    async fn get(&self, params: ProviderParams) -> ProviderResult;
}

pub struct ProviderParams {
    pub conversation_id: String,
    pub agent_id: String,
    pub message_text: String,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: HashMap<String, String>,
    pub text: String,
    pub data: Value,
}

pub struct MessageClassifierProvider;

impl MessageClassifierProvider {
    fn classify(text: &str) -> (&'static str, f64, &'static str, bool) {
        let lower = text.to_lowercase();

        if lower.contains("strategic") || lower.contains("strategy") {
            ("strategic", 0.8, "strategic_planning", true)
        } else if lower.contains("analyze") || lower.contains("analysis") {
            ("analysis", 0.8, "sequential_execution", true)
        } else if lower.contains("process") {
            ("processing", 0.8, "sequential_execution", false)
        } else if lower.contains("execute") || lower.contains("final") {
            ("execution", 0.8, "direct_action", false)
        } else if lower.contains("plan") || lower.contains("project") {
            ("strategic", 0.7, "strategic_planning", true)
        } else {
            ("general", 0.5, "direct_action", false)
        }
    }
}

#[async_trait]
impl Provider for MessageClassifierProvider {
    fn name(&self) -> &'static str {
        "messageClassifier"
    }

    fn description(&self) -> &'static str {
        "Classifies incoming messages by complexity and planning requirements"
    }

    fn position(&self) -> i32 {
        10
    }

    async fn get(&self, params: ProviderParams) -> ProviderResult {
        let (classification, confidence, planning_type, planning_required) =
            Self::classify(&params.message_text);

        let text = format!(
            "Message classified as: {} ({} complexity, {}) with confidence: {}",
            classification,
            if planning_required {
                "complex"
            } else {
                "simple"
            },
            planning_type,
            confidence
        );

        let values = HashMap::from([
            ("classification".to_string(), classification.to_string()),
            ("confidence".to_string(), confidence.to_string()),
            ("planningType".to_string(), planning_type.to_string()),
        ]);

        let data = serde_json::json!({
            "classification": classification,
            "confidence": confidence,
            "complexity": if planning_required { "complex" } else { "simple" },
            "planningType": planning_type,
            "planningRequired": planning_required,
        });

        ProviderResult { values, text, data }
    }
}

pub fn get_planning_provider_names() -> Vec<&'static str> {
    vec!["messageClassifier"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_strategic() {
        let (class, _, _, _) = MessageClassifierProvider::classify("create a strategic plan");
        assert_eq!(class, "strategic");
    }

    #[test]
    fn test_classify_general() {
        let (class, _, _, _) = MessageClassifierProvider::classify("hello world");
        assert_eq!(class, "general");
    }

    #[tokio::test]
    async fn test_provider_get() {
        let provider = MessageClassifierProvider;
        let params = ProviderParams {
            conversation_id: "test".to_string(),
            agent_id: "test".to_string(),
            message_text: "create a strategic plan".to_string(),
        };

        let result = provider.get(params).await;
        assert!(result.text.contains("strategic"));
    }
}
