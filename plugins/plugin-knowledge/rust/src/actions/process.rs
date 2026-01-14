use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, ActionResult, KnowledgeAction};

const KNOWLEDGE_KEYWORDS: &[&str] = &[
    "process",
    "add",
    "upload",
    "document",
    "knowledge",
    "learn",
    "remember",
    "store",
    "ingest",
    "file",
];

pub struct ProcessKnowledgeAction;

#[async_trait]
impl KnowledgeAction for ProcessKnowledgeAction {
    fn name(&self) -> &'static str {
        "PROCESS_KNOWLEDGE"
    }

    fn description(&self) -> &'static str {
        "Process and store knowledge from a file path or text content into the knowledge base"
    }

    fn validate(&self, context: &ActionContext) -> ActionResult<bool> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_keyword = KNOWLEDGE_KEYWORDS
            .iter()
            .any(|keyword| text.contains(keyword));
        let has_path = text.contains('/') && !text.contains("http");

        Ok(has_keyword || has_path)
    }

    async fn execute(&self, context: &ActionContext) -> ActionResult<Value> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let path_regex_pattern = r"(?:/[\w.\-]+)+|(?:[a-zA-Z]:[/\\][\w\s.\-]+(?:[/\\][\w\s.\-]+)*)";
        let path_match = regex::Regex::new(path_regex_pattern)
            .ok()
            .and_then(|re| re.find(text).map(|m| m.as_str().to_string()));

        if let Some(file_path) = path_match {
            Ok(serde_json::json!({
                "action": self.name(),
                "mode": "file",
                "file_path": file_path,
                "agent_id": context.agent_id,
                "room_id": context.room_id,
                "entity_id": context.entity_id,
                "status": "pending",
                "message": format!("Processing document at {}", file_path)
            }))
        } else {
            let knowledge_content = text
                .to_string()
                .trim_start_matches(|c: char| c.is_whitespace())
                .to_string();

            if knowledge_content.is_empty() {
                return Ok(serde_json::json!({
                    "action": self.name(),
                    "success": false,
                    "error": "No content provided to process"
                }));
            }

            Ok(serde_json::json!({
                "action": self.name(),
                "mode": "text",
                "content": knowledge_content,
                "agent_id": context.agent_id,
                "room_id": context.room_id,
                "entity_id": context.entity_id,
                "status": "pending",
                "message": "Processing text content"
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_name() {
        let action = ProcessKnowledgeAction;
        assert_eq!(action.name(), "PROCESS_KNOWLEDGE");
    }

    #[test]
    fn test_description() {
        let action = ProcessKnowledgeAction;
        assert!(!action.description().is_empty());
    }

    #[test]
    fn test_validate_with_keyword() {
        let action = ProcessKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Please process this document"
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
    fn test_validate_with_path() {
        let action = ProcessKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Load /path/to/document.pdf"
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
    fn test_validate_no_match() {
        let action = ProcessKnowledgeAction;

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
    async fn test_execute_with_path() {
        let action = ProcessKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Process /documents/test.pdf"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: Some("room-1".to_string()),
            entity_id: Some("entity-1".to_string()),
            state: serde_json::json!({}),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "PROCESS_KNOWLEDGE");
        assert_eq!(result["mode"], "file");
        assert!(result["file_path"]
            .as_str()
            .unwrap()
            .contains("/documents/test.pdf"));
    }

    #[tokio::test]
    async fn test_execute_with_text() {
        let action = ProcessKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": "Remember this: The capital of France is Paris"
                }
            }),
            agent_id: "test-agent".to_string(),
            room_id: Some("room-1".to_string()),
            entity_id: None,
            state: serde_json::json!({}),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "PROCESS_KNOWLEDGE");
        assert_eq!(result["mode"], "text");
    }

    #[tokio::test]
    async fn test_execute_empty_content() {
        let action = ProcessKnowledgeAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": {
                    "text": ""
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
