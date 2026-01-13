use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

#[async_trait]
pub trait Action: Send + Sync {
    fn name(&self) -> &'static str;
    fn similes(&self) -> Vec<&'static str>;
    fn description(&self) -> &'static str;
    async fn validate(&self, message_text: &str) -> bool;
    async fn handler(&self, params: Value) -> Result<Value, String>;
    fn examples(&self) -> Vec<ActionExample>;
}

pub struct ActionExample {
    pub input: String,
    pub output: String,
}

pub struct AnalyzeInputAction;

#[async_trait]
impl Action for AnalyzeInputAction {
    fn name(&self) -> &'static str {
        "ANALYZE_INPUT"
    }
    fn similes(&self) -> Vec<&'static str> {
        vec!["ANALYZE", "PARSE_INPUT"]
    }
    fn description(&self) -> &'static str {
        "Analyzes user input and extracts key information"
    }
    async fn validate(&self, _message_text: &str) -> bool {
        true
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let words: Vec<&str> = text.split_whitespace().collect();
        let lower = text.to_lowercase();
        let sentiment = if lower.contains("urgent") || lower.contains("emergency") {
            "urgent"
        } else if lower.contains("good") {
            "positive"
        } else if lower.contains("bad") {
            "negative"
        } else {
            "neutral"
        };

        Ok(serde_json::json!({
            "action": "ANALYZE_INPUT",
            "wordCount": words.len(),
            "hasNumbers": text.chars().any(|c| c.is_numeric()),
            "sentiment": sentiment,
            "topics": words.iter().filter(|w| w.len() >= 5).map(|w| w.to_lowercase()).collect::<Vec<_>>(),
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            input: "Analyze this complex problem".to_string(),
            output: "Analyzing the input...".to_string(),
        }]
    }
}

pub struct ProcessAnalysisAction;

#[async_trait]
impl Action for ProcessAnalysisAction {
    fn name(&self) -> &'static str {
        "PROCESS_ANALYSIS"
    }
    fn similes(&self) -> Vec<&'static str> {
        vec!["PROCESS", "MAKE_DECISIONS"]
    }
    fn description(&self) -> &'static str {
        "Processes the analysis results and makes decisions"
    }
    async fn validate(&self, _message_text: &str) -> bool {
        true
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let analysis = params
            .get("analysis")
            .ok_or_else(|| "Missing 'analysis' parameter".to_string())?;

        let word_count = analysis
            .get("wordCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let sentiment = analysis
            .get("sentiment")
            .and_then(|v| v.as_str())
            .unwrap_or("neutral");

        let suggested_response = match sentiment {
            "positive" => "Thank you for the positive feedback!",
            "negative" => "I understand your concerns and will help address them.",
            _ => "I can help you with that.",
        };

        Ok(serde_json::json!({
            "action": "PROCESS_ANALYSIS",
            "needsMoreInfo": word_count < 5,
            "isComplex": word_count > 20,
            "requiresAction": sentiment != "neutral" || word_count > 8,
            "suggestedResponse": suggested_response,
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            input: "Process the analysis results".to_string(),
            output: "Processing decisions...".to_string(),
        }]
    }
}

pub struct ExecuteFinalAction;

#[async_trait]
impl Action for ExecuteFinalAction {
    fn name(&self) -> &'static str {
        "EXECUTE_FINAL"
    }
    fn similes(&self) -> Vec<&'static str> {
        vec!["FINALIZE", "COMPLETE"]
    }
    fn description(&self) -> &'static str {
        "Executes the final action based on processing results"
    }
    async fn validate(&self, _message_text: &str) -> bool {
        true
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let decisions = params
            .get("decisions")
            .ok_or_else(|| "Missing 'decisions' parameter".to_string())?;

        let requires_action = decisions
            .get("requiresAction")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let suggested_response = decisions
            .get("suggestedResponse")
            .and_then(|v| v.as_str())
            .unwrap_or("Done.");

        Ok(serde_json::json!({
            "action": "EXECUTE_FINAL",
            "executedAction": if requires_action { "RESPOND" } else { "ACKNOWLEDGE" },
            "message": suggested_response,
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            input: "Execute the final step".to_string(),
            output: "Completing the chain...".to_string(),
        }]
    }
}

pub struct CreatePlanAction;

impl CreatePlanAction {
    fn is_plan_request(text: &str) -> bool {
        let lower = text.to_lowercase();
        lower.contains("plan")
            || lower.contains("project")
            || lower.contains("comprehensive")
            || lower.contains("organize")
            || lower.contains("strategy")
    }
}

#[async_trait]
impl Action for CreatePlanAction {
    fn name(&self) -> &'static str {
        "CREATE_PLAN"
    }
    fn similes(&self) -> Vec<&'static str> {
        vec!["PLAN_PROJECT", "GENERATE_PLAN", "MAKE_PLAN", "PROJECT_PLAN"]
    }
    fn description(&self) -> &'static str {
        "Creates a comprehensive project plan with multiple phases and tasks"
    }
    async fn validate(&self, message_text: &str) -> bool {
        Self::is_plan_request(message_text)
    }

    async fn handler(&self, _params: Value) -> Result<Value, String> {
        let plan_id = Uuid::new_v4().to_string();

        Ok(serde_json::json!({
            "action": "CREATE_PLAN",
            "planId": plan_id,
            "name": "Comprehensive Project Plan",
            "phases": [
                {
                    "id": "phase_1",
                    "name": "Setup and Infrastructure",
                    "tasks": ["Repository Setup"]
                },
                {
                    "id": "phase_2",
                    "name": "Research and Knowledge",
                    "tasks": ["Research Best Practices", "Process Knowledge"]
                },
                {
                    "id": "phase_3",
                    "name": "Task Management",
                    "tasks": ["Create Initial Tasks"]
                }
            ],
            "totalPhases": 3,
            "totalTasks": 4,
            "executionStrategy": "sequential",
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            input:
                "I need to launch a new open-source project. Please create a comprehensive plan."
                    .to_string(),
            output:
                "I've created a comprehensive 3-phase project plan for your open-source launch."
                    .to_string(),
        }]
    }
}

pub fn get_planning_action_names() -> Vec<&'static str> {
    vec![
        "ANALYZE_INPUT",
        "PROCESS_ANALYSIS",
        "EXECUTE_FINAL",
        "CREATE_PLAN",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_analyze_input() {
        let action = AnalyzeInputAction;
        let result = action
            .handler(serde_json::json!({"text": "hello world test"}))
            .await
            .unwrap();
        assert_eq!(result["wordCount"], 3);
    }

    #[tokio::test]
    async fn test_create_plan_validate() {
        let action = CreatePlanAction;
        assert!(action.validate("create a comprehensive plan").await);
        assert!(!action.validate("hello world").await);
    }
}
