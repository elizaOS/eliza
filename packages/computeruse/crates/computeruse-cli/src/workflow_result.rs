use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Workflow execution state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowState {
    Success,
    Failure,
    Exception,
    Skipped,
}

/// Standard workflow result format with business logic success indication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowResult {
    /// Execution status from the MCP server
    pub execution_status: String,
    /// Whether the workflow achieved its business goal
    pub success: bool,
    /// Workflow state (success/failure/skipped)
    pub state: WorkflowState,
    /// Human-readable message about the result
    pub message: String,
    /// Extracted data (if any)
    pub data: Option<Value>,
    /// Error details (if failed)
    pub error: Option<String>,
    /// Additional validation information
    pub validation: Option<Value>,
    /// Total duration in milliseconds
    pub duration_ms: Option<u64>,
    /// Number of steps executed
    pub executed_steps: Option<usize>,
}

impl WorkflowResult {
    /// Parse a workflow result from the MCP execute_sequence response
    pub fn from_mcp_response(response: &Value) -> Result<Self> {
        // Extract execution-level status
        let execution_status = response
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Check if there's parsed output from the output parser
        let parsed_output = response.get("parsed_output");

        // Determine business logic success and state
        let (success, state, message, data, error, validation) = if let Some(parsed) = parsed_output
        {
            // Check if workflow was skipped
            let skipped = parsed
                .get("skipped")
                .and_then(|s| s.as_bool())
                .unwrap_or(false);

            // Check if workflow encountered an exception
            let exception = parsed
                .get("exception")
                .and_then(|e| e.as_bool())
                .unwrap_or(false);

            // If there's an output parser result, use its success indication
            let success = if skipped || exception {
                false // skipped and exception workflows are not considered successful
            } else {
                parsed
                    .get("success")
                    .and_then(|s| s.as_bool())
                    .unwrap_or_else(|| {
                        // Fallback: check if data exists and is non-empty
                        if let Some(data) = parsed.get("data") {
                            match data {
                                Value::Array(arr) => !arr.is_empty(),
                                Value::Object(obj) => !obj.is_empty(),
                                Value::Null => false,
                                _ => true,
                            }
                        } else {
                            false
                        }
                    })
            };

            // Determine state - exception takes precedence over success/failure
            let state = if skipped {
                WorkflowState::Skipped
            } else if exception {
                WorkflowState::Exception
            } else if success {
                WorkflowState::Success
            } else {
                WorkflowState::Failure
            };

            let message = parsed
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or({
                    match state {
                        WorkflowState::Success => "Workflow completed successfully",
                        WorkflowState::Failure => "Workflow failed to achieve its goal",
                        WorkflowState::Exception => "Workflow encountered a system exception",
                        WorkflowState::Skipped => "Workflow skipped - conditions not met",
                    }
                })
                .to_string();

            let data = parsed.get("data").cloned();
            let error = parsed
                .get("error")
                .and_then(|e| e.as_str())
                .map(|s| s.to_string());
            let validation = parsed.get("validation").cloned();

            (success, state, message, data, error, validation)
        } else {
            // No output parser - determine success from execution status
            let success = execution_status == "success";
            let state = if success {
                WorkflowState::Success
            } else {
                WorkflowState::Failure
            };
            let message = if success {
                "Workflow executed successfully (no parser for business validation)"
            } else {
                "Workflow execution encountered errors"
            }
            .to_string();

            let error = if !success {
                response
                    .get("debug_info_on_failure")
                    .map(|d| serde_json::to_string_pretty(d).unwrap_or_default())
                    .or_else(|| Some("Workflow execution failed".to_string()))
            } else {
                None
            };

            (success, state, message, None, error, None)
        };

        // Extract timing and step information
        let duration_ms = response.get("total_duration_ms").and_then(|d| d.as_u64());

        let executed_steps = response
            .get("executed_tools")
            .and_then(|e| e.as_u64())
            .map(|n| n as usize);

        Ok(WorkflowResult {
            execution_status,
            success,
            state,
            message,
            data,
            error,
            validation,
            duration_ms,
            executed_steps,
        })
    }

    /// Display the result in a user-friendly format
    pub fn display(&self) {
        use colored::*;

        println!();
        println!("{}", "═".repeat(60));

        // Display success/failure/exception/skipped with color
        match self.state {
            WorkflowState::Success => {
                println!("{} {}", "✅ SUCCESS:".green().bold(), self.message);
            }
            WorkflowState::Failure => {
                println!("{} {}", "❌ FAILURE:".red().bold(), self.message);
            }
            WorkflowState::Exception => {
                println!("{} {}", "🚨 EXCEPTION:".bright_red().bold(), self.message);
            }
            WorkflowState::Skipped => {
                println!("{} {}", "⏭️  SKIPPED:".yellow().bold(), self.message);
            }
        }

        // Display execution details
        println!("{}", "─".repeat(60));
        println!("📊 Execution Details:");
        println!("   • Status: {}", self.execution_status);

        if let Some(steps) = self.executed_steps {
            println!("   • Steps Executed: {steps}");
        }

        if let Some(duration) = self.duration_ms {
            let seconds = duration as f64 / 1000.0;
            println!("   • Duration: {seconds:.2}s");
        }

        // Display extracted data if any
        if let Some(data) = &self.data {
            println!("{}", "─".repeat(60));
            println!("📦 Extracted Data:");

            // Pretty print the data
            match data {
                Value::Array(arr) => {
                    if arr.is_empty() {
                        println!("   (No data extracted)");
                    } else {
                        println!("   Found {} item(s):", arr.len());
                        for (i, item) in arr.iter().enumerate().take(5) {
                            if let Ok(pretty) = serde_json::to_string_pretty(item) {
                                for line in pretty.lines() {
                                    println!("   {line}");
                                }
                                if i < arr.len() - 1 && i < 4 {
                                    println!("   ---");
                                }
                            }
                        }
                        if arr.len() > 5 {
                            println!("   ... and {} more items", arr.len() - 5);
                        }
                    }
                }
                Value::Object(_) => {
                    if let Ok(pretty) = serde_json::to_string_pretty(data) {
                        for line in pretty.lines() {
                            println!("   {line}");
                        }
                    }
                }
                _ => {
                    println!("   {data:?}");
                }
            }
        }

        // Display validation info if present
        if let Some(validation) = &self.validation {
            println!("{}", "─".repeat(60));
            println!("✔️  Validation:");
            if let Ok(pretty) = serde_json::to_string_pretty(validation) {
                for line in pretty.lines() {
                    println!("   {line}");
                }
            }
        }

        // Display error if present
        if let Some(error) = &self.error {
            println!("{}", "─".repeat(60));
            println!("{} {}", "⚠️  Error:".yellow(), error);
        }

        println!("{}", "═".repeat(60));
        println!();
    }
}
