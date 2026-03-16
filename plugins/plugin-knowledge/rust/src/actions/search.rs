use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, ActionResult, KnowledgeAction};

const SEARCH_KEYWORDS: &[&str] = &[
    "search",
    "find",
    "look up",
    "query",
    "what do you know about",
];
const KNOWLEDGE_KEYWORDS: &[&str] = &["knowledge", "information", "document", "database"];

pub struct SearchKnowledgeAction;

#[async_trait]
impl KnowledgeAction for SearchKnowledgeAction {
    fn name(&self) -> &'static str {
        "SEARCH_KNOWLEDGE"
    }

    fn description(&self) -> &'static str {
        "Search the knowledge base for specific information"
    }

    fn validate(&self, context: &ActionContext) -> ActionResult<bool> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_search_keyword = SEARCH_KEYWORDS.iter().any(|keyword| text.contains(keyword));
        let has_knowledge_keyword = KNOWLEDGE_KEYWORDS
            .iter()
            .any(|keyword| text.contains(keyword));

        Ok(has_search_keyword && has_knowledge_keyword)
    }

    async fn execute(&self, context: &ActionContext) -> ActionResult<Value> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let query = text
            .to_lowercase()
            .replace("search", "")
            .replace("find", "")
            .replace("look up", "")
            .replace("query", "")
            .replace("your", "")
            .replace("my", "")
            .replace("knowledge", "")
            .replace("base", "")
            .replace("for", "")
            .replace("information", "")
            .replace("document", "")
            .replace("database", "")
            .trim()
            .to_string();

        if query.is_empty() {
            return Ok(serde_json::json!({
                "action": self.name(),
                "success": false,
                "error": "No search query provided",
                "message": "What would you like me to search for in my knowledge base?"
            }));
        }

        Ok(serde_json::json!({
            "action": self.name(),
            "query": query,
            "agent_id": context.agent_id,
            "room_id": context.room_id,
            "entity_id": context.entity_id,
            "status": "pending",
            "message": format!("Searching knowledge base for: {}", query)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_name() {
        let action = SearchKnowledgeAction;
        assert_eq!(action.name(), "SEARCH_KNOWLEDGE");
    }

    #[test]
    fn test_description() {
        let action = SearchKnowledgeAction;
        assert!(!action.description().is_empty());
    }

    #[test]
    fn test_validate_search_knowledge() {
        let action = SearchKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Search my knowledge base for quantum computing"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: Some("room-1".to_string()),
            entity_id: Some("entity-1".to_string()),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).unwrap());
    }

    #[test]
    fn test_validate_find_information() {
        let action = SearchKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Find information about AI"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: None,
            entity_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).unwrap());
    }

    #[test]
    fn test_validate_search_only() {
        let action = SearchKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Search for cats"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: None,
            entity_id: None,
            state: serde_json::json!({}),
        };

        // Should fail - no knowledge keyword
        assert!(!action.validate(&context).unwrap());
    }

    #[test]
    fn test_validate_no_match() {
        let action = SearchKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "What is the weather today?"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: None,
            entity_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).unwrap());
    }

    #[tokio::test]
    async fn test_execute_with_query() {
        let action = SearchKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Search knowledge base for quantum computing"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: Some("room-1".to_string()),
            entity_id: Some("entity-1".to_string()),
            state: serde_json::json!({}),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEARCH_KNOWLEDGE");
        assert!(result["query"].as_str().unwrap().contains("quantum"));
        assert_eq!(result["status"], "pending");
    }

    #[tokio::test]
    async fn test_execute_empty_query() {
        let action = SearchKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Search my knowledge base for"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: None,
            entity_id: None,
            state: serde_json::json!({}),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["success"], false);
        assert!(result["error"].as_str().is_some());
    }
}
