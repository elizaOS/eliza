use colored::*;
use serde_json::Value;

/// Validates workflow output structure and provides feedback
pub struct WorkflowOutputValidator;

impl WorkflowOutputValidator {
    /// Validate a workflow's output structure
    pub fn validate(output: &Value) -> ValidationResult {
        let mut result = ValidationResult::default();

        // Check for output field
        if let Some(parsed) = output.get("output") {
            result.has_output = true;
            Self::validate_output(parsed, &mut result);
        } else {
            result
                .warnings
                .push("No 'output' field found - workflow may lack output parser".to_string());
        }

        // Check execution-level fields
        if let Some(status) = output.get("status").and_then(|s| s.as_str()) {
            result.has_status = true;
            if !["success", "partial_success", "error"].contains(&status) {
                result.errors.push(format!(
                    "Invalid status value: '{status}'. Expected: success, partial_success, or error"
                ));
            }
        } else {
            result
                .errors
                .push("Missing required 'status' field".to_string());
        }

        // Check for results array
        if output.get("results").and_then(|r| r.as_array()).is_some() {
            result.has_results = true;
        } else {
            result
                .warnings
                .push("Missing or invalid 'results' array".to_string());
        }

        // Check timing information
        if output
            .get("total_duration_ms")
            .and_then(|d| d.as_u64())
            .is_some()
        {
            result.has_duration = true;
        }

        if output
            .get("executed_tools")
            .and_then(|e| e.as_u64())
            .is_some()
        {
            result.has_executed_count = true;
        }

        result
    }

    /// Validate the output structure
    fn validate_output(parsed: &Value, result: &mut ValidationResult) {
        // Check for success field (required)
        match parsed.get("success") {
            Some(Value::Bool(_)) => {
                result.parsed_has_success = true;
            }
            Some(_) => {
                result
                    .errors
                    .push("'output.success' must be a boolean".to_string());
            }
            None => {
                result
                    .errors
                    .push("Missing required 'output.success' field".to_string());
            }
        }

        // Check for message field (required)
        match parsed.get("message") {
            Some(Value::String(msg)) if !msg.is_empty() => {
                result.parsed_has_message = true;
            }
            Some(Value::String(_)) => {
                result
                    .warnings
                    .push("'output.message' is empty - provide meaningful feedback".to_string());
            }
            Some(_) => {
                result
                    .errors
                    .push("'output.message' must be a string".to_string());
            }
            None => {
                result
                    .errors
                    .push("Missing required 'output.message' field".to_string());
            }
        }

        // Check for data field (optional but recommended)
        if let Some(data) = parsed.get("data") {
            result.parsed_has_data = true;

            // Warn if data is empty when success is true
            if parsed.get("success") == Some(&Value::Bool(true)) {
                match data {
                    Value::Array(arr) if arr.is_empty() => {
                        result
                            .warnings
                            .push("'output.data' is empty array despite success:true".to_string());
                    }
                    Value::Object(obj) if obj.is_empty() => {
                        result
                            .warnings
                            .push("'output.data' is empty object despite success:true".to_string());
                    }
                    Value::Null => {
                        result
                            .warnings
                            .push("'output.data' is null despite success:true".to_string());
                    }
                    _ => {}
                }
            }
        } else if parsed.get("success") == Some(&Value::Bool(true)) {
            result.warnings.push(
                "No 'output.data' field despite success:true - consider including extracted data"
                    .to_string(),
            );
        }

        // Check for error field (should be present when success:false)
        if parsed.get("success") == Some(&Value::Bool(false))
            && parsed.get("error").is_none()
            && parsed.get("skipped") != Some(&Value::Bool(true))
        {
            result.warnings.push(
                "No 'output.error' field despite success:false - consider adding error details"
                    .to_string(),
            );
        }

        // Check for state field consistency
        if let Some(state) = parsed.get("state").and_then(|s| s.as_str()) {
            if !["success", "failure", "skipped"].contains(&state) {
                result.errors.push(format!(
                    "Invalid 'output.state': '{state}'. Expected: success, failure, or skipped"
                ));
            }

            // Check state consistency with success field
            let success = parsed
                .get("success")
                .and_then(|s| s.as_bool())
                .unwrap_or(false);
            let skipped = parsed
                .get("skipped")
                .and_then(|s| s.as_bool())
                .unwrap_or(false);

            match (state, success, skipped) {
                ("success", false, _) => {
                    result
                        .warnings
                        .push("Inconsistency: state='success' but success=false".to_string());
                }
                ("failure", true, _) => {
                    result
                        .warnings
                        .push("Inconsistency: state='failure' but success=true".to_string());
                }
                ("skipped", _, false) => {
                    result.warnings.push(
                        "Inconsistency: state='skipped' but skipped field is not true".to_string(),
                    );
                }
                _ => {}
            }
        }
    }

    /// Display validation results in a user-friendly format
    pub fn display_results(result: &ValidationResult) {
        println!();
        println!("{}", "═".repeat(60));
        println!("{}", "WORKFLOW OUTPUT VALIDATION REPORT".bold());
        println!("{}", "═".repeat(60));

        // Overall status
        let status = if result.errors.is_empty() {
            if result.warnings.is_empty() {
                "✅ VALID".green().bold()
            } else {
                "⚠️  VALID WITH WARNINGS".yellow().bold()
            }
        } else {
            "❌ INVALID".red().bold()
        };

        println!("\nStatus: {status}");
        println!("{}", "─".repeat(60));

        // Structure checks
        println!("\n{}", "Structure Checks:".bold());
        Self::print_check("Execution status field", result.has_status);
        Self::print_check("Results array", result.has_results);
        Self::print_check("Duration metrics", result.has_duration);
        Self::print_check("Execution count", result.has_executed_count);
        Self::print_check("Output parser", result.has_output);

        if result.has_output {
            println!("\n{}", "Parser Output Checks:".bold());
            Self::print_check("Success indicator", result.parsed_has_success);
            Self::print_check("Message field", result.parsed_has_message);
            Self::print_check("Data field", result.parsed_has_data);
        }

        // Errors
        if !result.errors.is_empty() {
            println!("\n{}", "Errors:".red().bold());
            for error in &result.errors {
                println!("  {} {}", "✗".red(), error);
            }
        }

        // Warnings
        if !result.warnings.is_empty() {
            println!("\n{}", "Warnings:".yellow().bold());
            for warning in &result.warnings {
                println!("  {} {}", "⚠".yellow(), warning);
            }
        }

        // Recommendations
        if !result.errors.is_empty() || !result.warnings.is_empty() {
            println!("\n{}", "Recommendations:".cyan().bold());

            if !result.has_output {
                println!("  • Add an output parser to extract structured data");
                println!("    See: docs/WORKFLOW_OUTPUT_STRUCTURE.md");
            }

            if !result.parsed_has_success {
                println!("  • Always include 'success: true/false' in output");
            }

            if !result.parsed_has_message {
                println!("  • Always include a meaningful 'message' field");
            }

            if !result.parsed_has_data && result.has_output {
                println!("  • Consider including 'data' field with extracted information");
            }
        }

        println!("\n{}", "═".repeat(60));
        println!();
    }

    fn print_check(label: &str, passed: bool) {
        let icon = if passed { "✓".green() } else { "✗".red() };
        let status = if passed {
            "Present".green()
        } else {
            "Missing".red()
        };
        println!("  {icon} {label}: {status}");
    }
}

/// Result of workflow output validation
#[derive(Default, Debug)]
pub struct ValidationResult {
    // Core structure
    pub has_status: bool,
    pub has_results: bool,
    pub has_duration: bool,
    pub has_executed_count: bool,
    pub has_output: bool,

    // Parsed output structure
    pub parsed_has_success: bool,
    pub parsed_has_message: bool,
    pub parsed_has_data: bool,

    // Issues found
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl ValidationResult {
    /// Check if the output is valid (no errors)
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }

    /// Get a score representing output quality (0-100)
    pub fn quality_score(&self) -> u8 {
        let mut score = 100u8;

        // Deduct for errors (20 points each)
        score = score.saturating_sub((self.errors.len() as u8) * 20);

        // Deduct for warnings (5 points each)
        score = score.saturating_sub((self.warnings.len() as u8) * 5);

        // Deduct for missing optional but recommended fields
        if !self.has_output {
            score = score.saturating_sub(10);
        }
        if self.has_output && !self.parsed_has_data {
            score = score.saturating_sub(5);
        }

        score
    }
}
