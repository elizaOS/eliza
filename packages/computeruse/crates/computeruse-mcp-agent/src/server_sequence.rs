use crate::execution_logger;
use crate::helpers::substitute_variables;
use crate::output_parser;
use crate::server::extract_content_json;
use crate::telemetry::{StepSpan, WorkflowSpan};
use crate::utils::{
    DesktopWrapper, ExecuteSequenceArgs, SequenceItem, ToolCall, ToolGroup, VariableDefinition,
};
use crate::workflow_typescript::{TypeScriptWorkflow, WorkflowEvent};
use rmcp::model::{
    CallToolResult, Content, LoggingLevel, LoggingMessageNotificationParam, NumberOrString,
    ProgressNotificationParam, ProgressToken,
};
use rmcp::service::{Peer, RequestContext, RoleServer};
use rmcp::ErrorData as McpError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, info, info_span, warn, Instrument};
use uuid::Uuid;

/// RAII guard to automatically reset the in_sequence flag when dropped
struct SequenceGuard {
    flag: Arc<Mutex<bool>>,
}

impl Drop for SequenceGuard {
    fn drop(&mut self) {
        // Reset flag to false when guard is dropped (function exits)
        if let Ok(mut flag) = self.flag.lock() {
            *flag = false;
        }
    }
}

impl SequenceGuard {
    fn new(flag: Arc<Mutex<bool>>) -> Self {
        // Set flag to true when guard is created
        if let Ok(mut f) = flag.lock() {
            *f = true;
        }
        Self { flag }
    }
}

/// Extract workflow folder name from URL
/// e.g., file:///C:/Users/matt/.../workflows/github-demo/src/computeruse.ts -> "github-demo"
fn extract_workflow_folder_from_url(url: &str) -> Option<String> {
    // Strip file:// prefix and handle both forward and back slashes
    let path = url
        .strip_prefix("file:///")
        .or_else(|| url.strip_prefix("file://"))?;

    // Normalize path separators
    let normalized = path.replace('\\', "/");

    // Find "workflows/" and extract the next path component
    if let Some(idx) = normalized.find("/workflows/") {
        let after_workflows = &normalized[idx + "/workflows/".len()..];
        // Get the folder name (up to next /)
        let folder = after_workflows.split('/').next()?;
        if !folder.is_empty() {
            debug!(
                "[extract_workflow_folder] Extracted folder '{}' from URL",
                folder
            );
            return Some(folder.to_string());
        }
    }

    None
}

/// Helper function to recursively validate a value against a variable definition
fn validate_variable_value(
    variable_name: &str,
    value: &Value,
    def: &VariableDefinition,
) -> Result<(), McpError> {
    match def.r#type {
        crate::utils::VariableType::String => {
            if !value.is_string() {
                return Err(McpError::invalid_params(
                    format!("Variable '{variable_name}' must be a string."),
                    Some(json!({"value": value})),
                ));
            }
        }
        crate::utils::VariableType::Number => {
            if !value.is_number() {
                return Err(McpError::invalid_params(
                    format!("Variable '{variable_name}' must be a number."),
                    Some(json!({"value": value})),
                ));
            }
        }
        crate::utils::VariableType::Boolean => {
            if !value.is_boolean() {
                return Err(McpError::invalid_params(
                    format!("Variable '{variable_name}' must be a boolean."),
                    Some(json!({"value": value})),
                ));
            }
        }
        crate::utils::VariableType::Enum => {
            let val_str = value.as_str().ok_or_else(|| {
                McpError::invalid_params(
                    format!("Enum variable '{variable_name}' must be a string."),
                    Some(json!({"value": value})),
                )
            })?;
            if let Some(options) = &def.options {
                if !options.contains(&val_str.to_string()) {
                    return Err(McpError::invalid_params(
                        format!("Variable '{variable_name}' has an invalid value."),
                        Some(json!({
                            "value": val_str,
                            "allowed_options": options
                        })),
                    ));
                }
            }
        }
        crate::utils::VariableType::Array => {
            if !value.is_array() {
                return Err(McpError::invalid_params(
                    format!("Variable '{variable_name}' must be an array."),
                    Some(json!({"value": value})),
                ));
            }
            // Validate each array item against item_schema if provided
            if let Some(item_schema) = &def.item_schema {
                if let Some(array) = value.as_array() {
                    for (index, item) in array.iter().enumerate() {
                        validate_variable_value(
                            &format!("{variable_name}[{index}]"),
                            item,
                            item_schema,
                        )?;
                    }
                }
            }
        }
        crate::utils::VariableType::Object => {
            if !value.is_object() {
                return Err(McpError::invalid_params(
                    format!("Variable '{variable_name}' must be an object."),
                    Some(json!({"value": value})),
                ));
            }

            let obj = value.as_object().unwrap();

            // Validate against properties if defined (for objects with known structure)
            if let Some(properties) = &def.properties {
                for (prop_key, prop_def) in properties {
                    if let Some(prop_value) = obj.get(prop_key) {
                        validate_variable_value(
                            &format!("{variable_name}.{prop_key}"),
                            prop_value,
                            prop_def,
                        )?;
                    } else if prop_def.required.unwrap_or(true) {
                        return Err(McpError::invalid_params(
                            format!("Required property '{variable_name}.{prop_key}' is missing."),
                            None,
                        ));
                    }
                }
            }

            // Validate against value_schema if defined (for flat key-value objects)
            if let Some(value_schema) = &def.value_schema {
                for (key, val) in obj {
                    validate_variable_value(&format!("{variable_name}.{key}"), val, value_schema)?;
                }
            }
        }
    }

    Ok(())
}

impl DesktopWrapper {
    // Get the state file path for a workflow
    // Uses OS-standard data directories:
    //   Windows: %LOCALAPPDATA%\mediar\workflows\<workflow_id>\state.json
    //   macOS: ~/Library/Application Support/mediar/workflows/<folder>/state.json
    //   Linux: ~/.local/share/mediar/workflows/<folder>/state.json
    // Priority: Extract folder from URL (matches actual workflow folder)
    async fn get_state_file_path(
        _workflow_id: Option<&str>, // Kept for backward compat, but unused
        workflow_url: Option<&str>,
    ) -> Option<PathBuf> {
        let data_dir = dirs::data_local_dir()?;

        // Extract folder name from URL (e.g., "github-demo" from file:///...workflows/github-demo/src/...)
        if let Some(url) = workflow_url {
            if let Some(folder) = extract_workflow_folder_from_url(url) {
                debug!("Using folder '{}' for state file", folder);
                let state_file = data_dir
                    .join("mediar")
                    .join("workflows")
                    .join(&folder)
                    .join("state.json");
                return Some(state_file);
            }
        }

        None
    }

    // Save env state after any step that modifies it
    async fn save_workflow_state(
        workflow_id: Option<&str>,
        workflow_url: Option<&str>,
        step_id: Option<&str>,
        step_index: usize,
        env: &serde_json::Value,
    ) -> Result<(), McpError> {
        if let Some(state_file) = Self::get_state_file_path(workflow_id, workflow_url).await {
            if let Some(state_dir) = state_file.parent() {
                tokio::fs::create_dir_all(state_dir).await.map_err(|e| {
                    McpError::internal_error(format!("Failed to create state directory: {e}"), None)
                })?;
            }

            let state = json!({
                "last_updated": chrono::Utc::now().to_rfc3339(),
                "last_step_id": step_id,
                "last_step_index": step_index,
                "workflow_id": workflow_id,
                "workflow_file": workflow_url.and_then(|url| {
                    Path::new(url.strip_prefix("file://").unwrap_or(url))
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string())
                }),
                "env": env,
            });

            tokio::fs::write(
                &state_file,
                serde_json::to_string_pretty(&state).map_err(|e| {
                    McpError::internal_error(format!("Failed to serialize state: {e}"), None)
                })?,
            )
            .await
            .map_err(|e| {
                McpError::internal_error(format!("Failed to write state file: {e}"), None)
            })?;

            debug!("Saved workflow state to: {:?}", state_file);
        }
        Ok(())
    }

    // Load env state when starting from a specific step
    async fn load_workflow_state(
        workflow_id: Option<&str>,
        workflow_url: Option<&str>,
    ) -> Result<Option<serde_json::Value>, McpError> {
        if let Some(state_file) = Self::get_state_file_path(workflow_id, workflow_url).await {
            if state_file.exists() {
                let content = tokio::fs::read_to_string(&state_file).await.map_err(|e| {
                    McpError::internal_error(format!("Failed to read state file: {e}"), None)
                })?;
                let state: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
                    McpError::internal_error(format!("Failed to parse state file: {e}"), None)
                })?;

                if let Some(env) = state.get("env") {
                    debug!(
                        "Loaded workflow state from step {} ({})",
                        state["last_step_index"],
                        state["last_step_id"].as_str().unwrap_or("unknown")
                    );
                    return Ok(Some(env.clone()));
                }
            } else {
                debug!("No saved workflow state found at: {:?}", state_file);
            }
        }
        Ok(None)
    }

    /// Helper function to create a flattened execution context where env properties
    /// are available both under 'env.' prefix and directly at the top level.
    /// This enables conditions to access env variables directly without the 'env.' prefix,
    /// matching the behavior of script execution.
    fn create_flattened_execution_context(
        execution_context_map: &serde_json::Map<String, serde_json::Value>,
    ) -> serde_json::Value {
        let mut flattened_map = execution_context_map.clone();

        // Flatten env properties to top level
        if let Some(env_value) = flattened_map.get("env") {
            if let Some(env_obj) = env_value.as_object() {
                // Clone env properties to avoid borrow issues
                let env_entries: Vec<(String, serde_json::Value)> = env_obj
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();

                // Insert each env property at top level
                // Note: env properties will override existing top-level keys with same name
                for (key, value) in env_entries {
                    flattened_map.insert(key, value);
                }
            }
        }

        serde_json::Value::Object(flattened_map)
    }

    /// Deep merge JSON values - recursively merges objects, overwrites other types
    /// This matches the Python executor's deep_merge behavior:
    /// - For objects: recursively merge keys from source into target
    /// - For other types: source value overwrites target value
    fn deep_merge_json(target: &mut serde_json::Map<String, Value>, source: &Value) {
        if let Some(source_obj) = source.as_object() {
            for (key, source_value) in source_obj {
                if let Some(target_value) = target.get_mut(key) {
                    // Key exists in target
                    if target_value.is_object() && source_value.is_object() {
                        // Both are objects - recursively merge
                        if let Some(target_obj) = target_value.as_object_mut() {
                            Self::deep_merge_json(target_obj, source_value);
                        }
                    } else {
                        // Not both objects - source overwrites target
                        *target_value = source_value.clone();
                    }
                } else {
                    // Key doesn't exist in target - add it
                    target.insert(key.clone(), source_value.clone());
                }
            }
        }
    }

    pub async fn execute_sequence_impl(
        &self,
        peer: Peer<RoleServer>,
        request_context: RequestContext<RoleServer>,
        client_progress_token: Option<ProgressToken>,
        args: ExecuteSequenceArgs,
    ) -> Result<CallToolResult, McpError> {
        // Register this execution with the request manager
        // This allows stop_execution to cancel it
        let request_id = format!("execute_sequence_{}", Uuid::new_v4());
        let cancel_context = self
            .request_manager
            .register(
                request_id.clone(),
                Some(600000), // 10 minute timeout for workflows
            )
            .await;

        // Use tokio::select to handle cancellation from request manager
        // Create span with trace_id for distributed tracing - all nested logs inherit it
        let trace_id_val = args.trace_id.clone().unwrap_or_default();
        let execution_id_val = args.execution_id.clone().unwrap_or_default();
        let tracing_span = info_span!(
            "execute_ts_workflow",
            trace_id = %trace_id_val,
            execution_id = %execution_id_val,
            log_source = "agent",
        );

        tokio::select! {
            result = self.execute_sequence_inner(peer, client_progress_token.clone(), request_context, args, request_id.clone()).instrument(tracing_span) => {
                // Unregister when done
                self.request_manager.unregister(&request_id).await;
                result
            }
            _ = cancel_context.cancellation_token.cancelled() => {
                // Unregister on cancellation
                self.request_manager.unregister(&request_id).await;
                Err(McpError::internal_error(
                    "Workflow execution cancelled by stop_execution",
                    Some(json!({"code": -32001, "request_id": request_id}))
                ))
            }
        }
    }

    async fn execute_sequence_inner(
        &self,
        peer: Peer<RoleServer>,
        client_progress_token: Option<ProgressToken>,
        request_context: RequestContext<RoleServer>,
        args: ExecuteSequenceArgs,
        execution_id: String,
    ) -> Result<CallToolResult, McpError> {
        // Set the in_sequence flag for the duration of this function
        // This flag will be automatically reset to false when this guard is dropped
        let _sequence_guard = SequenceGuard::new(self.in_sequence.clone());

        // Validate that either URL or steps are provided
        if args.url.is_none() && args.steps.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
            return Err(McpError::invalid_params(
                "Either 'url' or 'steps' must be provided".to_string(),
                None,
            ));
        }

        // If URL is provided, delegate to TypeScript workflow executor
        if let Some(url) = args.url.clone() {
            info!("Delegating to TypeScript workflow executor");
            return self
                .execute_typescript_workflow(&url, args, execution_id, peer, client_progress_token)
                .await;
        }

        // No URL provided - continue with inline step execution
        // This path is used when MCP clients pass steps directly (e.g., Claude batching UI operations)
        info!("No URL provided - executing inline steps");

        // Set the scripts_base_path for file resolution in run_command and execute_browser_script
        if let Some(scripts_base_path) = &args.scripts_base_path {
            let mut scripts_base_path_guard = self.current_scripts_base_path.lock().await;
            *scripts_base_path_guard = Some(scripts_base_path.clone());
            info!(
                "[SCRIPTS_BASE_PATH] Setting scripts_base_path for workflow: {}",
                scripts_base_path
            );
            info!(
                "[SCRIPTS_BASE_PATH] Script files will be searched first in: {}",
                scripts_base_path
            );
            info!("[SCRIPTS_BASE_PATH] Fallback search will use workflow directory or current directory");
        } else {
            info!(
                "[SCRIPTS_BASE_PATH] No scripts_base_path specified, using default file resolution"
            );
        }

        // Handle backward compatibility: 'continue' is opposite of 'stop_on_error'
        let stop_on_error = if let Some(continue_exec) = args.r#continue {
            !continue_exec // continue=true means stop_on_error=false
        } else {
            args.stop_on_error.unwrap_or(true)
        };

        // Handle verbosity levels
        // quiet: minimal output (just success/failure)
        // normal: moderate output (includes tool results/logs but may omit some metadata)
        // verbose: full output (includes all details and metadata)
        let include_detailed = match args.verbosity.as_deref() {
            Some("quiet") => false,
            Some("verbose") => true,
            Some("normal") | None => args.include_detailed_results.unwrap_or(false), // Changed default to false
            _ => args.include_detailed_results.unwrap_or(false), // Changed default to false
        };

        // Re-enabling validation logic
        if let Some(variable_schema) = &args.variables {
            let inputs_map = args
                .inputs
                .as_ref()
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();

            for (key, def) in variable_schema {
                let value = inputs_map.get(key).or(def.default.as_ref());

                match value {
                    Some(val) => {
                        // Use the recursive validation helper function
                        validate_variable_value(key, val, def)?;
                    }
                    None => {
                        if def.required.unwrap_or(true) {
                            return Err(McpError::invalid_params(
                                format!("Required variable '{key}' is missing."),
                                None,
                            ));
                        }
                    }
                }
            }
        }

        // Build the execution context. It's a combination of the 'inputs' and 'selectors'.
        // The context is a simple, flat map of variables that will be used for substitution in tool arguments.
        let mut execution_context_map = serde_json::Map::new();

        // First, populate with default values from variables schema
        if let Some(variable_schema) = &args.variables {
            for (key, def) in variable_schema {
                if let Some(default_value) = &def.default {
                    execution_context_map.insert(key.clone(), default_value.clone());
                }
            }
        }

        // Then override with user-provided inputs (inputs take precedence over defaults)
        if let Some(inputs) = &args.inputs {
            // Validate inputs is an object
            if let Err(err) = crate::utils::validate_inputs(inputs) {
                return Err(McpError::invalid_params(
                    format!(
                        "Invalid inputs: {} expected {}, got {}",
                        err.field, err.expected, err.actual
                    ),
                    None,
                ));
            }
            if let Some(inputs_map) = inputs.as_object() {
                for (key, value) in inputs_map {
                    execution_context_map.insert(key.clone(), value.clone());
                }
            }
        }

        if let Some(selectors) = args.selectors.clone() {
            // Validate selectors
            if let Err(err) = crate::utils::validate_selectors(&selectors) {
                return Err(McpError::invalid_params(
                    format!(
                        "Invalid selectors: {} expected {}, got {}",
                        err.field, err.expected, err.actual
                    ),
                    None,
                ));
            }
            // If selectors is a string, parse it as JSON first
            let selectors_value = if let serde_json::Value::String(s) = &selectors {
                match serde_json::from_str::<serde_json::Value>(s) {
                    Ok(parsed) => parsed,
                    Err(_) => selectors, // If parsing fails, treat it as a raw string
                }
            } else {
                selectors
            };
            execution_context_map.insert("selectors".to_string(), selectors_value);
        }

        // Initialize an internal env bag with the inputs and other values
        let mut env_map = serde_json::Map::new();

        // Add all inputs to the env so they're accessible in JavaScript
        if let Some(inputs) = &args.inputs {
            if let Some(inputs_obj) = inputs.as_object() {
                for (key, value) in inputs_obj {
                    env_map.insert(key.clone(), value.clone());
                }
                // Also store the entire inputs object
                env_map.insert("inputs".to_string(), inputs.clone());
            }
        }

        execution_context_map.insert("env".to_string(), serde_json::Value::Object(env_map));

        // Build a map from step ID to its index for quick lookup (includes both main and troubleshooting steps)
        use std::collections::HashMap;
        let mut id_to_index: HashMap<String, usize> = HashMap::new();

        // Map main workflow steps
        if let Some(steps) = &args.steps {
            for (idx, step) in steps.iter().enumerate() {
                if let Some(id) = &step.id {
                    if id_to_index.insert(id.clone(), idx).is_some() {
                        warn!(
                            "Duplicate step id '{}' found; later occurrence overrides earlier.",
                            id
                        );
                    }
                }
            }
        }

        // Track the boundary between main steps and troubleshooting steps
        let main_steps_len = args.steps.as_ref().map(|s| s.len()).unwrap_or(0);

        // Map troubleshooting steps (they come after main steps in the sequence)
        if let Some(troubleshooting) = &args.troubleshooting {
            for (idx, step) in troubleshooting.iter().enumerate() {
                if let Some(id) = &step.id {
                    let global_idx = main_steps_len + idx;
                    if id_to_index.insert(id.clone(), global_idx).is_some() {
                        warn!(
                            "Duplicate step id '{}' found in troubleshooting; later occurrence overrides earlier.",
                            id
                        );
                    }
                }
            }
        }

        // NEW: Check if we should start from a specific step (now searches both main and troubleshooting)
        let start_from_index = if let Some(start_step) = &args.start_from_step {
            // Find the step index by ID using the complete map
            id_to_index.get(start_step).copied().ok_or_else(|| {
                McpError::invalid_params(
                    format!("start_from_step '{start_step}' not found in workflow or troubleshooting steps"),
                    Some(json!({
                        "requested_step": start_step,
                        "available_steps": id_to_index.keys().cloned().collect::<Vec<_>>()
                    })),
                )
            })?
        } else {
            0
        };

        // NEW: Check if we should end at a specific step (now searches both main and troubleshooting)
        let end_at_index = if let Some(end_step) = &args.end_at_step {
            // Find the step index by ID (inclusive) using the complete map
            id_to_index.get(end_step).copied().ok_or_else(|| {
                McpError::invalid_params(
                    format!(
                        "end_at_step '{end_step}' not found in workflow or troubleshooting steps"
                    ),
                    Some(json!({
                        "requested_step": end_step,
                        "available_steps": id_to_index.keys().cloned().collect::<Vec<_>>()
                    })),
                )
            })?
        } else {
            // No end_at_step specified, run to the end of MAIN steps only
            // This preserves the default behavior of not entering troubleshooting during normal execution
            main_steps_len.saturating_sub(1)
        };

        // NEW: Load saved state if starting from a specific step
        if start_from_index > 0 {
            if let Some(saved_env) =
                Self::load_workflow_state(args.workflow_id.as_deref(), args.url.as_deref()).await?
            {
                execution_context_map.insert("env".to_string(), saved_env);
                debug!(
                    "Loaded saved env state for resuming from step {}",
                    start_from_index
                );
            }
        }

        let execution_context = Self::create_flattened_execution_context(&execution_context_map);
        debug!(
            "Executing sequence with context: {}",
            serde_json::to_string_pretty(&execution_context).unwrap_or_default()
        );
        // Extract attributes early for logging
        let log_source = "agent";
        let trace_id_val = args.trace_id.as_deref().unwrap_or("");
        let execution_id_val = args.execution_id.as_deref().unwrap_or("");

        info!(
            log_source = %log_source,
            execution_id = %execution_id_val,
            trace_id = %trace_id_val,
            steps = args.steps.as_ref().map(|s| s.len()).unwrap_or(0),
            stop_on_error = %stop_on_error,
            include_detailed = %include_detailed,
            "Starting execute_sequence [execution_id={}, trace_id={}]", execution_id_val, trace_id_val
        );

        // Start workflow telemetry span
        let workflow_name = "execute_sequence";
        let mut workflow_span = WorkflowSpan::new(workflow_name);

        // Add execution metadata for filtering/grouping
        workflow_span.set_attribute("workflow.execution_id", execution_id.clone());
        workflow_span.set_attribute("log_source", log_source.to_string());

        // Add trace_id for distributed tracing if provided by executor
        if let Some(trace_id) = &args.trace_id {
            workflow_span.set_attribute("trace_id", trace_id.clone());
        }

        // Add execution_id for distributed tracing if provided by executor
        if let Some(exec_id) = &args.execution_id {
            workflow_span.set_attribute("execution_id", exec_id.clone());
        }

        workflow_span.set_attribute(
            "workflow.total_steps",
            args.steps
                .as_ref()
                .map(|s| s.len())
                .unwrap_or(0)
                .to_string(),
        );
        workflow_span.set_attribute("workflow.stop_on_error", stop_on_error.to_string());

        // Add workflow source metadata
        if let Some(url) = &args.url {
            workflow_span.set_attribute("workflow.url", url.clone());
            // All workflows are now TypeScript
            workflow_span.set_attribute("workflow.format", "typescript".to_string());
        } else {
            workflow_span.set_attribute("workflow.format", "inline".to_string());
        }

        // Add trigger source (from MCP API)
        workflow_span.set_attribute("workflow.trigger_source", "mcp_api".to_string());

        // Add organization/user context from environment if available
        if let Ok(org_id) = std::env::var("ORGANIZATION_ID") {
            workflow_span.set_attribute("organization.id", org_id);
        }
        if let Ok(user_id) = std::env::var("USER_ID") {
            workflow_span.set_attribute("user.id", user_id);
        }

        // Add execution mode from environment
        let execution_mode =
            std::env::var("EXECUTION_MODE").unwrap_or_else(|_| "normal".to_string());
        workflow_span.set_attribute("workflow.execution_mode", execution_mode);

        // Convert flattened SequenceStep to internal SequenceItem representation
        let mut sequence_items = Vec::new();
        let empty_steps = Vec::new();
        let steps = args.steps.as_ref().unwrap_or(&empty_steps);
        for (step_idx, step) in steps.iter().enumerate() {
            let item = if let Some(tool_name) = &step.tool_name {
                // Parse delay from either delay_ms or human-readable delay field
                let delay_ms = if let Some(delay_str) = &step.delay {
                    match crate::duration_parser::parse_duration(delay_str) {
                        Ok(ms) => Some(ms),
                        Err(e) => {
                            warn!("Failed to parse delay '{}': {}", delay_str, e);
                            step.delay_ms // Fall back to delay_ms
                        }
                    }
                } else {
                    step.delay_ms
                };

                let tool_call = ToolCall {
                    tool_name: tool_name.clone(),
                    arguments: step.arguments.clone().unwrap_or(serde_json::json!({})),
                    continue_on_error: step.continue_on_error,
                    delay_ms,
                    id: step.id.clone(),
                };
                SequenceItem::Tool { tool_call }
            } else if let Some(group_name) = &step.group_name {
                let tool_group = ToolGroup {
                    group_name: group_name.clone(),
                    steps: step
                        .steps
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|s| ToolCall {
                            tool_name: s.tool_name,
                            arguments: s.arguments,
                            continue_on_error: s.continue_on_error,
                            delay_ms: s.delay_ms,
                            id: s.id,
                        })
                        .collect(),
                    skippable: step.skippable,
                };
                SequenceItem::Group { tool_group }
            } else {
                let is_in_range = step_idx >= start_from_index && step_idx <= end_at_index;
                let range_info = if is_in_range {
                    "This step IS in your execution range."
                } else {
                    "This step is OUTSIDE your execution range but still blocks execution."
                };
                return Err(McpError::invalid_params(
                    format!(
                        "Step {} is invalid: missing tool_name or group_name. {}",
                        step_idx + 1,
                        range_info
                    ),
                    Some(json!({
                        "error_type": "invalid_step",
                        "step_index": step_idx + 1,
                        "step_id": step.id,
                        "is_in_execution_range": is_in_range,
                        "execution_range": {
                            "start": start_from_index + 1,
                            "end": end_at_index + 1
                        }
                    })),
                ));
            };
            sequence_items.push(item);
        }

        // Add troubleshooting steps to the sequence (they won't execute unless jumped to via fallback_id)
        if let Some(troubleshooting) = &args.troubleshooting {
            info!(
                "Adding {} troubleshooting steps to workflow (accessible only via fallback_id)",
                troubleshooting.len()
            );
            for (local_idx, step) in troubleshooting.iter().enumerate() {
                let global_step_idx = main_steps_len + local_idx;
                let item = if let Some(tool_name) = &step.tool_name {
                    // Parse delay from either delay_ms or human-readable delay field
                    let delay_ms = if let Some(delay_str) = &step.delay {
                        match crate::duration_parser::parse_duration(delay_str) {
                            Ok(ms) => Some(ms),
                            Err(e) => {
                                warn!("Failed to parse delay '{}': {}", delay_str, e);
                                step.delay_ms // Fall back to delay_ms
                            }
                        }
                    } else {
                        step.delay_ms
                    };

                    let tool_call = ToolCall {
                        tool_name: tool_name.clone(),
                        arguments: step.arguments.clone().unwrap_or(serde_json::json!({})),
                        continue_on_error: step.continue_on_error,
                        delay_ms,
                        id: step.id.clone(),
                    };
                    SequenceItem::Tool { tool_call }
                } else if let Some(group_name) = &step.group_name {
                    let tool_group = ToolGroup {
                        group_name: group_name.clone(),
                        steps: step
                            .steps
                            .clone()
                            .unwrap_or_default()
                            .into_iter()
                            .map(|s| ToolCall {
                                tool_name: s.tool_name,
                                arguments: s.arguments,
                                continue_on_error: s.continue_on_error,
                                delay_ms: s.delay_ms,
                                id: s.id,
                            })
                            .collect(),
                        skippable: step.skippable,
                    };
                    SequenceItem::Group { tool_group }
                } else {
                    let is_in_range =
                        global_step_idx >= start_from_index && global_step_idx <= end_at_index;
                    let range_info = if is_in_range {
                        "This step IS in your execution range."
                    } else {
                        "This step is OUTSIDE your execution range but still blocks execution."
                    };
                    return Err(McpError::invalid_params(
                        format!(
                            "Troubleshooting step {} (global index {}) is invalid: missing tool_name or group_name. {}",
                            local_idx + 1, global_step_idx + 1, range_info
                        ),
                        Some(json!({
                            "error_type": "invalid_step",
                            "step_index": global_step_idx + 1,
                            "troubleshooting_index": local_idx + 1,
                            "step_id": step.id,
                            "is_in_execution_range": is_in_range,
                            "execution_range": {
                                "start": start_from_index + 1,
                                "end": end_at_index + 1
                            }
                        })),
                    ));
                };
                sequence_items.push(item);
            }
        }

        // ---------------------------
        // PRE-FLIGHT CHECK: Chrome Extension Health
        // ---------------------------
        // Check if workflow contains any execute_browser_script steps
        // If yes, verify Chrome extension is connected before starting execution
        let has_browser_script_steps = steps.iter().any(|step| {
            step.tool_name
                .as_ref()
                .map(|t| t == "execute_browser_script")
                .unwrap_or(false)
        }) || args
            .troubleshooting
            .as_ref()
            .map(|t| {
                t.iter().any(|step| {
                    step.tool_name
                        .as_ref()
                        .map(|t| t == "execute_browser_script")
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        // Check if we should run the pre-flight check
        // Skip if: 1) no browser script steps, OR 2) skip_preflight_check flag is set
        let should_run_preflight =
            has_browser_script_steps && !args.skip_preflight_check.unwrap_or(false);

        if has_browser_script_steps && args.skip_preflight_check.unwrap_or(false) {
            info!("Skipping browser extension pre-flight check (skip_preflight_check=true)");
        }

        if should_run_preflight {
            info!(
                "Workflow contains execute_browser_script steps - checking Chrome extension health"
            );

            // Initialize the extension bridge (starts WebSocket server on port 17373)
            let bridge = computeruse::extension_bridge::ExtensionBridge::global().await;

            // Trigger browser activity to wake up the extension
            // Navigate to a blank page in CHROME to trigger the extension's content script
            info!("Triggering Chrome browser activity to wake up extension...");
            match computeruse::Desktop::new_default() {
                Ok(desktop) => {
                    match desktop.open_url("about:blank", Some(computeruse::Browser::Chrome)) {
                        Ok(_chrome_window) => {
                            info!("Chrome navigation triggered successfully");
                            // Give the extension a moment to detect the page load and connect
                            tokio::time::sleep(Duration::from_millis(300)).await;
                        }
                        Err(e) => {
                            warn!("Failed to navigate Chrome: {:?}", e);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to create Desktop instance: {:?}", e);
                }
            }

            // Now test extension connection with a minimal eval (ping)
            // This uses the same 10-second retry logic as execute_browser_script
            // The ping executes in the about:blank tab we just opened
            info!("Testing Chrome extension connection with ping script...");
            let ping_result = bridge
                .eval_in_active_tab("true", Duration::from_secs(10))
                .await;

            let is_connected = ping_result.is_ok() && ping_result.as_ref().unwrap().is_some();

            // Get updated health status after connection attempt
            let bridge_health =
                computeruse::extension_bridge::ExtensionBridge::health_status().await;
            let status = bridge_health
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let clients = bridge_health
                .get("clients")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            if !is_connected {
                warn!(
                    "Chrome extension not connected before workflow execution: status={}, clients={}",
                    status,
                    clients
                );

                // End workflow span
                workflow_span.set_status(false, "Chrome extension not available");
                workflow_span.end();

                return Err(McpError::invalid_params(
                    "Chrome extension bridge is not connected",
                    Some(json!({
                        "error_type": "extension_unavailable",
                        "extension_status": status,
                        "extension_clients": clients,
                        "workflow_file": args.url.as_ref(),
                        "browser_script_steps_count": sequence_items.iter().filter(|item| {
                            matches!(item, SequenceItem::Tool { tool_call } if tool_call.tool_name == "execute_browser_script")
                        }).count(),
                        "troubleshooting": [
                            "Verify Chrome extension is installed and enabled at chrome://extensions",
                            "Extension ID: Check computeruse browser-extension folder",
                            "Ensure Chrome browser is running",
                            "Check if WebSocket port 17373 is accessible",
                            "Try restarting Chrome browser",
                            "Review extension bridge health: http://127.0.0.1:3000/health (HTTP transport)"
                        ],
                        "health_details": bridge_health
                    })),
                ));
            }

            info!(
                "✅ Chrome extension healthy: {} client(s) connected",
                clients
            );

            // Close the about:blank tab now that we've confirmed the extension works
            match computeruse::Desktop::new_default() {
                Ok(desktop) => {
                    match desktop.press_key("{Ctrl}w").await {
                        Ok(_) => {
                            info!("Closed about:blank tab with Ctrl+W");
                            // Wait for tab close to complete before starting workflow
                            tokio::time::sleep(Duration::from_millis(300)).await;
                        }
                        Err(e) => warn!("Failed to close about:blank tab: {:?}", e),
                    }
                }
                Err(e) => warn!("Failed to create Desktop instance for tab cleanup: {:?}", e),
            }
        }

        // ---------------------------
        // Fallback-enabled execution loop (while-based)
        // ---------------------------

        let mut results = Vec::new();
        let mut sequence_had_errors = false;
        let mut critical_error_occurred = false;
        let mut used_fallback = false; // Track if any fallback was used
        let mut actually_executed_count = 0usize; // Track only steps that actually executed (not skipped)
        let mut cancelled_by_user = false; // Track if execution was cancelled by user
        let start_time = chrono::Utc::now();

        let mut current_index: usize = start_from_index;
        let max_iterations = sequence_items.len() * 10; // Prevent infinite fallback loops
        let mut iterations = 0usize;

        // Track whether we've jumped to troubleshooting
        let mut jumped_to_troubleshooting = false;

        // Track last executed process for window management
        let mut last_executed_process: Option<String> = None;

        // Detect if we're starting directly in the troubleshooting section
        if start_from_index >= main_steps_len {
            jumped_to_troubleshooting = true;
            info!(
                "Starting execution directly in troubleshooting section at step index {} (troubleshooting step #{})",
                start_from_index,
                start_from_index - main_steps_len + 1
            );
        }

        // Get follow_fallback setting
        // - Default to true for unbounded execution (no end_at_step) to allow troubleshooting fallbacks
        // - Default to false for bounded execution (with end_at_step) to respect boundaries
        let follow_fallback = args.follow_fallback.unwrap_or(args.end_at_step.is_none());
        if args.end_at_step.is_some() {
            info!("follow_fallback={} for bounded execution", follow_fallback);
        } else {
            info!("follow_fallback={} for unbounded execution (defaulting to true for troubleshooting access)", follow_fallback);
        }

        // Log if we're skipping steps
        if start_from_index > 0 {
            let step_type = if start_from_index >= main_steps_len {
                "troubleshooting"
            } else {
                "main workflow"
            };
            info!(
                "Starting from {} step at index {}",
                step_type, start_from_index
            );
        }

        // Log if we're stopping at a specific step
        if end_at_index < sequence_items.len() - 1 {
            let step_type = if end_at_index >= main_steps_len {
                "troubleshooting"
            } else {
                "main workflow"
            };
            info!(
                "Will stop after {} step at index {} (inclusive)",
                step_type, end_at_index
            );
        }

        // Capture initial window state before executing any steps
        // This captures state before step 0 (which might open new windows)
        // Check if window management is enabled (defaults to true for backward compatibility)
        let window_mgmt_enabled = args.window_mgmt.enable_window_management.unwrap_or(true);
        if window_mgmt_enabled {
            if let Err(e) = self.window_manager.capture_initial_state().await {
                tracing::warn!(
                    "Failed to capture initial window state before sequence: {}",
                    e
                );
            } else {
                tracing::info!("Captured initial window state before sequence execution");
            }
        } else {
            tracing::debug!("Window management disabled for sequence, skipping capture");
        }

        while current_index < sequence_items.len()
            && (current_index <= end_at_index || (follow_fallback && jumped_to_troubleshooting))
            && iterations < max_iterations
        {
            iterations += 1;

            // Check if the request has been cancelled
            if request_context.ct.is_cancelled() {
                warn!("Request cancelled by user, stopping sequence execution");
                cancelled_by_user = true;
                break; // Exit loop gracefully and return partial results
            }

            // Get the original step from either main steps or troubleshooting steps
            let original_step = if current_index < main_steps_len {
                args.steps.as_ref().and_then(|s| s.get(current_index))
            } else {
                args.troubleshooting
                    .as_ref()
                    .and_then(|t| t.get(current_index - main_steps_len))
            };

            // Extract values from the step if it exists
            let (if_expr, retries, fallback_id_opt) = if let Some(step) = original_step {
                (
                    step.r#if.clone(),
                    step.retries.unwrap_or(0),
                    step.fallback_id.clone(),
                )
            } else {
                (None, 0, None)
            };

            let is_always_step = if_expr.as_deref().is_some_and(|s| s.trim() == "always()");

            // If a critical error occurred and this step is NOT an 'always' step, skip it.
            if critical_error_occurred && !is_always_step {
                results.push(json!({
                    "index": current_index,
                    "status": "skipped",
                    "executed": false,
                    "reason": "Skipped due to a previous unrecoverable error in the sequence."
                }));
                current_index += 1;
                continue;
            }

            // 1. Evaluate condition, unless it's an 'always' step.
            if let Some(cond_str) = &if_expr {
                let execution_context =
                    Self::create_flattened_execution_context(&execution_context_map);
                if !is_always_step
                    && !crate::expression_eval::evaluate(cond_str, &execution_context)
                {
                    info!(
                        "Skipping step {} due to if expression not met: `{}`",
                        current_index, cond_str
                    );
                    results.push(json!({
                        "index": current_index,
                        "status": "skipped",
                        "executed": false,
                        "reason": format!("if_expr not met: {}", cond_str)
                    }));
                    current_index += 1;
                    continue;
                }
            }

            // Log step BEGIN only after skip checks - this ensures we only log steps that will actually execute
            if let Some(step) = original_step {
                if let Some(tool_name) = &step.tool_name {
                    info!(
                        "Step {} BEGIN tool='{}' id='{}' retries={} if_expr={:?} fallback_id={:?} jumps={}",
                        current_index,
                        tool_name,
                        step.id.as_deref().unwrap_or(""),
                        step.retries.unwrap_or(0),
                        step.r#if,
                        step.fallback_id,
                        step.jumps.as_ref().map(|j| j.len()).unwrap_or(0)
                    );
                } else if let Some(group_name) = &step.group_name {
                    info!(
                        "Step {} BEGIN group='{}' id='{}' steps={}",
                        current_index,
                        group_name,
                        step.id.as_deref().unwrap_or(""),
                        step.steps.as_ref().map(|v| v.len()).unwrap_or(0)
                    );
                }
            }

            // 2. Execute with retries
            let mut final_result = json!(null);
            let mut step_error_occurred = false;
            let total_steps = sequence_items.len();

            for attempt in 0..=retries {
                let item = &mut sequence_items[current_index];
                match item {
                    SequenceItem::Tool { tool_call } => {
                        // Special internal pseudo-tool to set env for subsequent steps
                        let tool_name_normalized = tool_call
                            .tool_name
                            .strip_prefix("mcp_computeruse-mcp-agent_")
                            .unwrap_or(&tool_call.tool_name)
                            .to_string();

                        // Substitute variables in arguments before execution
                        let execution_context =
                            Self::create_flattened_execution_context(&execution_context_map);
                        let mut substituted_args = tool_call.arguments.clone();
                        substitute_variables(&mut substituted_args, &execution_context);

                        // Inject workflow variables and accumulated env for run_command and execute_browser_script
                        if matches!(
                            tool_call.tool_name.as_str(),
                            "run_command" | "execute_browser_script"
                        ) {
                            // Get env object or create empty one
                            let mut env_obj = substituted_args
                                .get("env")
                                .and_then(|v| v.as_object())
                                .cloned()
                                .unwrap_or_else(serde_json::Map::new);

                            // Always inject workflow variables (scripts depend on them)
                            // Extract default values from VariableDefinition objects for consistency
                            if let Some(workflow_vars) = &args.variables {
                                let mut resolved_vars = serde_json::Map::new();

                                // Step 1: Start with defaults from variable schema
                                for (key, def) in workflow_vars {
                                    if let Some(default_value) = &def.default {
                                        resolved_vars.insert(key.clone(), default_value.clone());
                                    }
                                }

                                // Step 2: Deep merge runtime inputs (overrides defaults)
                                // This allows UI-provided parameters to override variable defaults
                                if let Some(inputs) = &args.inputs {
                                    tracing::debug!(
                                        "[workflow_variables] Before merge: {}",
                                        serde_json::to_string(&resolved_vars).unwrap_or_default()
                                    );
                                    Self::deep_merge_json(&mut resolved_vars, inputs);
                                    tracing::debug!(
                                        "[workflow_variables] After merge: {}",
                                        serde_json::to_string(&resolved_vars).unwrap_or_default()
                                    );
                                }

                                env_obj.insert(
                                    "_workflow_variables".to_string(),
                                    json!(resolved_vars),
                                );
                            }

                            // Always inject accumulated env so scripts can access previous step results
                            if let Some(accumulated_env) = execution_context.get("env") {
                                env_obj.insert(
                                    "_accumulated_env".to_string(),
                                    accumulated_env.clone(),
                                );
                            }

                            // Update the arguments
                            if let Some(args_obj) = substituted_args.as_object_mut() {
                                args_obj.insert("env".to_string(), json!(env_obj));
                            }
                        }

                        // Start step telemetry span
                        let step_id = original_step.and_then(|s| s.id.as_deref());
                        let mut step_span = StepSpan::new(&tool_call.tool_name, step_id);
                        step_span.set_attribute("step.number", (current_index + 1).to_string());
                        step_span.set_attribute("step.total", total_steps.to_string());
                        if attempt > 0 {
                            step_span.set_attribute("step.retry_attempt", attempt.to_string());
                        }

                        // Add workflow execution_id to step for correlation
                        step_span.set_attribute("workflow.execution_id", execution_id.clone());

                        // Extract and add step-level metadata for filtering/grouping
                        // Extract current process from arguments
                        let current_process = substituted_args
                            .get("process")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        if let Some(ref proc) = current_process {
                            step_span.set_attribute("step.process", proc.clone());
                        }

                        // Extract selector if present (common in UI automation tools)
                        if let Some(selector) = substituted_args.get("selector") {
                            let selector_str = if let Some(s) = selector.as_str() {
                                s.to_string()
                            } else if let Some(obj) = selector.as_object() {
                                // Handle selector object with "selector" field
                                obj.get("selector")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("complex_selector")
                                    .to_string()
                            } else {
                                "complex_selector".to_string()
                            };
                            step_span.set_attribute("step.selector", selector_str);
                        }

                        // Extract window_selector if present
                        if let Some(window_selector) = substituted_args
                            .get("window_selector")
                            .and_then(|v| v.as_str())
                        {
                            step_span
                                .set_attribute("step.window_selector", window_selector.to_string());
                        }

                        // Extract URL for browser navigation tools
                        if let Some(url) = substituted_args.get("url").and_then(|v| v.as_str()) {
                            step_span.set_attribute("step.url", url.to_string());
                        }

                        // Extract text for typing tools
                        if let Some(text) = substituted_args.get("text").and_then(|v| v.as_str()) {
                            // Only log first 50 chars to avoid PII/sensitive data
                            let text_preview = if text.len() > 50 {
                                format!("{}...", &text[..50])
                            } else {
                                text.to_string()
                            };
                            step_span.set_attribute("step.text_length", text.len().to_string());
                            step_span.set_attribute("step.text_preview", text_preview);
                        }

                        // Add event for step started
                        workflow_span.add_event(
                            "step.started",
                            vec![
                                ("step.tool", tool_call.tool_name.clone()),
                                ("step.index", current_index.to_string()),
                            ],
                        );

                        // Create execution context for window management + logging
                        let step_id = original_step.and_then(|s| s.id.clone());
                        let execution_context = Some(
                            crate::utils::ToolExecutionContext::sequence_step(
                                args.url.clone().unwrap_or_default(),
                                current_index + 1, // 1-based for user display
                                total_steps,
                                last_executed_process.clone(),
                            )
                            .with_workflow_context(
                                args.url
                                    .as_deref()
                                    .and_then(extract_workflow_folder_from_url),
                                step_id.clone(),
                            ),
                        );

                        let (result, error_occurred) = self
                            .execute_single_tool(
                                peer.clone(),
                                request_context.clone(),
                                &tool_call.tool_name,
                                &substituted_args,
                                tool_call.continue_on_error.unwrap_or(false),
                                current_index,
                                include_detailed,
                                step_id.as_deref(),
                                execution_context,
                            )
                            .await;

                        final_result = result.clone();

                        // Update last_executed_process for window management
                        if let Some(ref proc) = current_process {
                            last_executed_process = Some(proc.clone());
                        }

                        // NEW: Store tool result in env if step has an ID (for ALL tools, not just scripts)
                        if let Some(step_id) = original_step.and_then(|s| s.id.as_deref()) {
                            let result_key = format!("{step_id}_result");
                            let status_key = format!("{step_id}_status");

                            // Extract the meaningful content from the result
                            let mut result_content =
                                if let Some(result_obj) = final_result.get("result") {
                                    // For tools, extract the actual content
                                    if let Some(content) = result_obj.get("content") {
                                        content.clone()
                                    } else {
                                        result_obj.clone()
                                    }
                                } else {
                                    // Fallback to the entire result if no nested structure
                                    final_result.clone()
                                };

                            // REMOVE server_logs before storing in env (they're debug data, not operational data)
                            if let Some(obj) = result_content.as_object_mut() {
                                if obj.contains_key("server_logs") {
                                    let log_count = obj
                                        .get("server_logs")
                                        .and_then(|logs| logs.as_array())
                                        .map(|arr| arr.len())
                                        .unwrap_or(0);
                                    obj.remove("server_logs");
                                    debug!(
                                        "Removed {} server_logs from {}_result before storing in env",
                                        log_count, step_id
                                    );
                                }
                            }

                            // Store at root level for easier expression access
                            execution_context_map
                                .insert(result_key.clone(), result_content.clone());
                            execution_context_map
                                .insert(status_key.clone(), final_result["status"].clone());

                            // Also store in env
                            if let Some(env_value) = execution_context_map.get_mut("env") {
                                if let Some(env_map) = env_value.as_object_mut() {
                                    env_map.insert(result_key.clone(), result_content);
                                    env_map
                                        .insert(status_key.clone(), final_result["status"].clone());

                                    info!(
                                        "Stored tool result for step '{}' as '{}' at root and env levels",
                                        step_id, result_key
                                    );

                                    // Save state after storing tool result
                                    Self::save_workflow_state(
                                        args.workflow_id.as_deref(),
                                        args.url.as_deref(),
                                        Some(step_id),
                                        current_index,
                                        env_value,
                                    )
                                    .await
                                    .ok(); // Don't fail the workflow if state save fails
                                }
                            }
                        }

                        // Update step span status and end it
                        // Check for executed_without_error status or legacy success boolean
                        let success = result["status"] == "executed_without_error"
                            || result["success"] == true
                            || (result["status"].is_null() && result["success"] != false);
                        step_span.set_status(
                            success,
                            if !success {
                                result["error"].as_str()
                            } else {
                                None
                            },
                        );
                        step_span.end();

                        // Add workflow event for step completion
                        workflow_span.add_event(
                            "step.completed",
                            vec![
                                ("step.tool", tool_call.tool_name.clone()),
                                ("step.index", current_index.to_string()),
                                (
                                    "step.status",
                                    result["status"].as_str().unwrap_or("unknown").to_string(),
                                ),
                            ],
                        );

                        // Define reserved keys that shouldn't auto-merge
                        const RESERVED_KEYS: &[&str] =
                            &["status", "error", "logs", "duration_ms", "set_env"];

                        // Merge env updates from engine/script-based steps into the internal context
                        if (tool_name_normalized == "execute_browser_script"
                            || tool_name_normalized == "run_command")
                            && final_result["status"] == "executed_without_error"
                        {
                            // Helper to merge updates into the env context map
                            let mut merge_env_obj = |update_val: &serde_json::Value| {
                                if let Some(update_map) = update_val.as_object() {
                                    if let Some(env_value) = execution_context_map.get_mut("env") {
                                        if let Some(env_map) = env_value.as_object_mut() {
                                            for (k, v) in update_map.iter() {
                                                env_map.insert(k.clone(), v.clone());
                                            }
                                        }
                                    }
                                }
                            };

                            // Special handling for execute_browser_script
                            if tool_name_normalized == "execute_browser_script" {
                                // Browser scripts return their result as a plain string in final_result["result"]["content"][0]["result"]
                                if let Some(result_str) = final_result
                                    .get("result")
                                    .and_then(|r| r.get("content"))
                                    .and_then(|c| c.as_array())
                                    .and_then(|arr| arr.first())
                                    .and_then(|item| item.get("result"))
                                    .and_then(|r| r.as_str())
                                {
                                    info!(
                                        "[execute_browser_script] Browser script returned: {}",
                                        result_str
                                    );
                                    // Try to parse the browser script result as JSON
                                    match serde_json::from_str::<serde_json::Value>(result_str) {
                                        Ok(parsed_json) => {
                                            info!("[execute_browser_script] Successfully parsed browser result as JSON");

                                            // First handle explicit set_env for backward compatibility
                                            if let Some(set_env) = parsed_json.get("set_env") {
                                                info!("[execute_browser_script] Found set_env in browser script result, merging into context");
                                                merge_env_obj(set_env);
                                            }

                                            // Then auto-merge non-reserved fields
                                            if let Some(obj) = parsed_json.as_object() {
                                                if let Some(env_value) =
                                                    execution_context_map.get_mut("env")
                                                {
                                                    if let Some(env_map) = env_value.as_object_mut()
                                                    {
                                                        for (k, v) in obj {
                                                            if RESERVED_KEYS.contains(&k.as_str()) {
                                                                warn!(
                                                                    "[execute_browser_script] Script returned reserved field '{}' which will be ignored. Reserved fields: {:?}",
                                                                    k, RESERVED_KEYS
                                                                );
                                                            } else {
                                                                env_map
                                                                    .insert(k.clone(), v.clone());
                                                                info!("[execute_browser_script] Auto-merged field '{}' to env", k);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            info!("[execute_browser_script] Browser result is not JSON: {}", e);
                                        }
                                    }
                                } else {
                                    info!("[execute_browser_script] Could not extract browser script result string from response structure");
                                }
                            } else if tool_name_normalized == "run_command" {
                                // Original logic for run_command
                                if let Some(content_arr) = final_result
                                    .get("result")
                                    .and_then(|r| r.get("content"))
                                    .and_then(|c| c.as_array())
                                {
                                    for item in content_arr {
                                        // Typical engine payload is under item.result
                                        if let Some(res) = item.get("result") {
                                            // First handle explicit set_env/env for backward compatibility
                                            if let Some(v) =
                                                res.get("set_env").or_else(|| res.get("env"))
                                            {
                                                merge_env_obj(v);
                                            }
                                        }
                                        // Also support top-level set_env/env directly on the item
                                        if let Some(v) =
                                            item.get("set_env").or_else(|| item.get("env"))
                                        {
                                            merge_env_obj(v);
                                        }
                                    }

                                    // Auto-merge non-reserved fields from run_command results
                                    for item in content_arr {
                                        if let Some(res) = item.get("result") {
                                            if let Some(obj) = res.as_object() {
                                                if let Some(env_value) =
                                                    execution_context_map.get_mut("env")
                                                {
                                                    if let Some(env_map) = env_value.as_object_mut()
                                                    {
                                                        for (k, v) in obj {
                                                            if !RESERVED_KEYS.contains(&k.as_str())
                                                            {
                                                                env_map
                                                                    .insert(k.clone(), v.clone());
                                                                info!("[run_command] Auto-merged field '{}' to env", k);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // NEW: Auto-merge non-reserved fields from root level
                                    // This enables scripts to return data directly without wrapping in 'result'
                                    for item in content_arr {
                                        // Try two approaches:
                                        // 1. If the result is a JSON string, parse it and merge fields
                                        // 2. If the item itself is an object with fields, merge those

                                        // Approach 1: Parse JSON string from result field
                                        if let Some(result_str) =
                                            item.get("result").and_then(|r| r.as_str())
                                        {
                                            // Try to parse the result string as JSON
                                            if let Ok(parsed_json) =
                                                serde_json::from_str::<serde_json::Value>(
                                                    result_str,
                                                )
                                            {
                                                if let Some(parsed_obj) = parsed_json.as_object() {
                                                    if let Some(env_value) =
                                                        execution_context_map.get_mut("env")
                                                    {
                                                        if let Some(env_map) =
                                                            env_value.as_object_mut()
                                                        {
                                                            // Define structural keys that should not be merged
                                                            const STRUCTURAL_KEYS: &[&str] = &[
                                                                "result", "action", "mode",
                                                                "engine", "content",
                                                            ];

                                                            for (k, v) in parsed_obj {
                                                                // Check if it's a reserved key
                                                                if RESERVED_KEYS
                                                                    .contains(&k.as_str())
                                                                {
                                                                    warn!(
                                                                        "[run_command] Script returned reserved field '{}' at root level which will be ignored. Reserved fields: {:?}",
                                                                        k, RESERVED_KEYS
                                                                    );
                                                                    continue;
                                                                }

                                                                // Skip structural keys silently
                                                                if STRUCTURAL_KEYS
                                                                    .contains(&k.as_str())
                                                                {
                                                                    continue;
                                                                }

                                                                // Merge the field (overwrite to ensure updates)
                                                                env_map
                                                                    .insert(k.clone(), v.clone());
                                                                info!("[run_command] Auto-merged root field '{}' from parsed JSON to env", k);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // Approach 2: Direct object fields (for backward compatibility)
                                        if let Some(obj) = item.as_object() {
                                            if let Some(env_value) =
                                                execution_context_map.get_mut("env")
                                            {
                                                if let Some(env_map) = env_value.as_object_mut() {
                                                    // Define structural keys that should not be merged
                                                    const STRUCTURAL_KEYS: &[&str] = &[
                                                        "result", "action", "mode", "engine",
                                                        "content",
                                                    ];

                                                    for (k, v) in obj {
                                                        // Check if it's a reserved key
                                                        if RESERVED_KEYS.contains(&k.as_str()) {
                                                            warn!(
                                                                "[run_command] Script returned reserved field '{}' at root level which will be ignored. Reserved fields: {:?}",
                                                                k, RESERVED_KEYS
                                                            );
                                                            continue;
                                                        }

                                                        // Skip structural keys silently
                                                        if STRUCTURAL_KEYS.contains(&k.as_str()) {
                                                            continue;
                                                        }

                                                        // Merge the field (overwrite to ensure updates)
                                                        env_map.insert(k.clone(), v.clone());
                                                        debug!("[run_command] Auto-merged root field '{}' to env", k);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // NEW: Save state after env update
                            if let Some(env_value) = execution_context_map.get("env") {
                                Self::save_workflow_state(
                                    args.workflow_id.as_deref(),
                                    args.url.as_deref(),
                                    original_step.and_then(|s| s.id.as_deref()),
                                    current_index,
                                    env_value,
                                )
                                .await
                                .ok(); // Don't fail the workflow if state save fails
                            }
                        }
                        // Check for executed_without_error status or legacy success boolean
                        if result["status"] == "executed_without_error"
                            || result["success"] == true
                            || (result["status"].is_null() && result["success"] != false)
                        {
                            // Apply delay after successful execution
                            if let Some(delay_ms) = tool_call.delay_ms {
                                if delay_ms > 0 {
                                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                }
                            }
                            break;
                        }

                        if error_occurred {
                            // Only mark as critical if there's no fallback to handle it
                            if fallback_id_opt.is_none() {
                                critical_error_occurred = true;
                                if let Some(id) = original_step.and_then(|s| s.id.as_deref()) {
                                    tracing::warn!(
                                        step_id = %id,
                                        tool = %tool_call.tool_name,
                                        attempt = attempt + 1,
                                        skippable = %tool_call.continue_on_error.unwrap_or(false),
                                        has_fallback = false,
                                        "Tool failed with unrecoverable error (no fallback)"
                                    );
                                } else {
                                    tracing::warn!(
                                        tool = %tool_call.tool_name,
                                        attempt = attempt + 1,
                                        skippable = %tool_call.continue_on_error.unwrap_or(false),
                                        has_fallback = false,
                                        "Tool failed with unrecoverable error (no fallback)"
                                    );
                                }
                            } else {
                                // Has fallback, log but don't mark as critical
                                if let Some(id) = original_step.and_then(|s| s.id.as_deref()) {
                                    tracing::info!(
                                        step_id = %id,
                                        tool = %tool_call.tool_name,
                                        fallback_id = %fallback_id_opt.as_ref().unwrap(),
                                        "Tool failed but has fallback configured"
                                    );
                                } else {
                                    tracing::info!(
                                        tool = %tool_call.tool_name,
                                        fallback_id = %fallback_id_opt.as_ref().unwrap(),
                                        "Tool failed but has fallback configured"
                                    );
                                }
                            }
                        }
                        step_error_occurred = true;
                        sequence_had_errors = true;

                        if let Some(delay_ms) = tool_call.delay_ms {
                            if delay_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            }
                        }
                    }
                    SequenceItem::Group { tool_group } => {
                        let mut group_had_errors = false;
                        let mut group_results = Vec::new();
                        let is_skippable = tool_group.skippable.unwrap_or(false);

                        for (step_index, step_tool_call) in tool_group.steps.iter_mut().enumerate()
                        {
                            // Substitute variables in arguments before execution
                            let execution_context =
                                Self::create_flattened_execution_context(&execution_context_map);
                            let mut substituted_args = step_tool_call.arguments.clone();
                            substitute_variables(&mut substituted_args, &execution_context);

                            // Extract current process from arguments
                            let current_process = substituted_args
                                .get("process")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            // Create execution context for window management + logging
                            let step_id_for_ctx = step_tool_call.id.clone();
                            let tool_execution_context = Some(
                                crate::utils::ToolExecutionContext::sequence_step(
                                    args.url.clone().unwrap_or_default(),
                                    current_index + 1, // 1-based for user display
                                    total_steps,
                                    last_executed_process.clone(),
                                )
                                .with_workflow_context(
                                    args.url
                                        .as_deref()
                                        .and_then(extract_workflow_folder_from_url),
                                    step_id_for_ctx.clone(),
                                ),
                            );

                            let (result, error_occurred) = self
                                .execute_single_tool(
                                    peer.clone(),
                                    request_context.clone(),
                                    &step_tool_call.tool_name,
                                    &substituted_args,
                                    step_tool_call.continue_on_error.unwrap_or(false),
                                    step_index,
                                    include_detailed,
                                    step_id_for_ctx.as_deref(), // Use step ID if available
                                    tool_execution_context,
                                )
                                .await;

                            group_results.push(result.clone());

                            // Update last_executed_process for window management
                            if let Some(ref proc) = current_process {
                                last_executed_process = Some(proc.clone());
                            }

                            if let Some(delay_ms) = step_tool_call.delay_ms {
                                if delay_ms > 0 {
                                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                }
                            }

                            // Check for failure - not executed_without_error and not legacy success boolean
                            let tool_failed = !(result["status"] == "executed_without_error"
                                || result["success"] == true
                                || (result["status"].is_null() && result["success"] != false));
                            if tool_failed {
                                group_had_errors = true;
                                if error_occurred || is_skippable {
                                    if error_occurred && !is_skippable {
                                        // Only mark as critical if there's no fallback to handle it
                                        if fallback_id_opt.is_none() {
                                            critical_error_occurred = true;
                                        }
                                    }
                                    tracing::warn!(
                                        group = %tool_group.group_name,
                                        tool = %step_tool_call.tool_name,
                                        step_index = step_index,
                                        step_id = %step_tool_call.id.clone().unwrap_or_default(),
                                        skippable = %is_skippable,
                                        has_fallback = fallback_id_opt.is_some(),
                                        "Group step failed; breaking out of group"
                                    );
                                    break;
                                }
                            }
                        }

                        let group_status = if group_had_errors {
                            "executed_with_partial_errors"
                        } else {
                            "executed_without_error"
                        };

                        if group_status != "executed_without_error" {
                            sequence_had_errors = true;
                            step_error_occurred = true;
                        }

                        if group_had_errors && !is_skippable && stop_on_error {
                            // Only mark as critical if there's no fallback to handle it
                            if fallback_id_opt.is_none() {
                                critical_error_occurred = true;
                            }
                        }

                        final_result = json!({
                            "group_name": &tool_group.group_name,
                            "status": group_status,
                            "results": group_results
                        });

                        if !group_had_errors {
                            break; // Group succeeded, break retry loop.
                        }
                    }
                }
                if attempt < retries {
                    warn!(
                        "Step {} failed on attempt {}/{}. Retrying...",
                        current_index,
                        attempt + 1,
                        retries
                    );
                    tokio::time::sleep(Duration::from_millis(500)).await; // Wait before retry
                }
            }

            // Mark this step as executed (not skipped) and add to results
            if let Some(obj) = final_result.as_object_mut() {
                obj.insert("executed".to_string(), json!(true));
            }
            results.push(final_result);
            actually_executed_count += 1;

            // Decide next index based on success or fallback
            let step_succeeded = !step_error_occurred;
            let step_status_str = if step_succeeded {
                "executed_without_error"
            } else {
                "executed_with_error"
            };
            if let Some(tool_name) = original_step.and_then(|s| s.tool_name.as_ref()) {
                info!(
                    "Step {} END tool='{}' id='{}' status={}",
                    current_index,
                    tool_name,
                    original_step.and_then(|s| s.id.as_deref()).unwrap_or(""),
                    step_status_str
                );
            } else if let Some(group_name) = original_step.and_then(|s| s.group_name.as_ref()) {
                info!(
                    "Step {} END group='{}' id='{}' status={}",
                    current_index,
                    group_name,
                    original_step.and_then(|s| s.id.as_deref()).unwrap_or(""),
                    step_status_str
                );
            }

            if step_succeeded {
                // Check for conditional jumps on success
                let mut performed_jump = false;

                // Check if we should skip jump evaluation at the end_at_step boundary
                // When end_at_step is specified, jumps are skipped by default at the boundary
                // to provide predictable execution bounds. Users can override this with
                // --execute-jumps-at-end to allow jumps even at the boundary (e.g., for loops).
                let execute_jumps_at_end = args.execute_jumps_at_end.unwrap_or(false);
                let skip_jumps = current_index == end_at_index && !execute_jumps_at_end;

                if skip_jumps {
                    info!(
                        "Skipping jump evaluation at end_at_step boundary (step index {}). Use --execute-jumps-at-end to enable jumps at boundary.",
                        current_index
                    );
                } else if let Some(jumps) = original_step.and_then(|s| s.jumps.as_ref()) {
                    if !jumps.is_empty() {
                        info!(
                            "Evaluating {} jump condition(s) for step {}",
                            jumps.len(),
                            current_index
                        );

                        let execution_context =
                            Self::create_flattened_execution_context(&execution_context_map);

                        for (idx, jump) in jumps.iter().enumerate() {
                            debug!(
                                "Evaluating jump condition {}/{}: {}",
                                idx + 1,
                                jumps.len(),
                                jump.condition
                            );

                            if crate::expression_eval::evaluate(&jump.condition, &execution_context)
                            {
                                // This condition matched - perform the jump
                                if let Some(&target_idx) = id_to_index.get(&jump.to_id) {
                                    let reason = jump
                                        .reason
                                        .as_ref()
                                        .map(|r| format!(": \"{r}\""))
                                        .unwrap_or_default();

                                    info!(
                                        "Step {} succeeded. Jump condition {}/{} matched{}. Jumping to '{}' (index {})",
                                        current_index, idx + 1, jumps.len(), reason, jump.to_id, target_idx
                                    );

                                    // Check if jumping into troubleshooting section
                                    if target_idx >= main_steps_len && !jumped_to_troubleshooting {
                                        jumped_to_troubleshooting = true;
                                        info!(
                                            "Entered troubleshooting section via conditional jump"
                                        );
                                    }

                                    current_index = target_idx;
                                    performed_jump = true;
                                    break; // Stop evaluating remaining conditions
                                } else {
                                    warn!(
                                        "Jump target '{}' not found for step {} condition {}. Continuing to next condition.",
                                        jump.to_id, current_index, idx + 1
                                    );
                                }
                            } else {
                                debug!("Jump condition {}/{} did not match", idx + 1, jumps.len());
                            }
                        }

                        if !performed_jump {
                            debug!("No jump conditions matched for step {}", current_index);
                        }
                    }
                }

                // Only increment if we didn't jump
                if !performed_jump {
                    // For successful steps, check if we're about to enter troubleshooting section
                    if !jumped_to_troubleshooting && current_index >= main_steps_len - 1 {
                        // We're at or past the last main step and haven't jumped to troubleshooting
                        // Exit the loop to prevent entering troubleshooting during normal flow
                        info!("Completed all main workflow steps successfully");
                        break;
                    }
                    current_index += 1;
                }
            } else if let Some(fb_id) = fallback_id_opt {
                if let Some(&fb_idx) = id_to_index.get(&fb_id) {
                    // Check if we should follow this fallback based on end_at_step and follow_fallback setting
                    let should_follow_fallback = if args.end_at_step.is_some()
                        && current_index >= end_at_index
                    {
                        // We're at or past end_at_step boundary
                        if follow_fallback {
                            info!(
                                "Step {} failed at end_at_step boundary. Following fallback to '{}' (follow_fallback=true).",
                                current_index, fb_id
                            );
                            true
                        } else {
                            info!(
                                "Step {} failed at end_at_step boundary. NOT following fallback '{}' (follow_fallback=false).",
                                current_index, fb_id
                            );
                            false
                        }
                    } else {
                        // Normal execution, always follow fallback
                        true
                    };

                    if should_follow_fallback {
                        info!(
                            "Step {} failed. Jumping to fallback step with id '{}' (index {}).",
                            current_index, fb_id, fb_idx
                        );

                        // Mark that we used a fallback
                        used_fallback = true;

                        // Check if we're jumping into the troubleshooting section
                        if fb_idx >= main_steps_len {
                            jumped_to_troubleshooting = true;
                            info!("Entered troubleshooting section via fallback");
                        }

                        current_index = fb_idx;
                    } else {
                        // Don't follow fallback, treat as normal failure
                        // Break the loop since we're at end_at_step and not following fallback
                        info!(
                            "Stopping execution at end_at_step boundary without following fallback"
                        );
                        break;
                    }
                } else {
                    warn!(
                        "fallback_id '{}' for step {} not found. Continuing to next step.",
                        fb_id, current_index
                    );
                    current_index += 1;
                }
            } else {
                // Step failed with no fallback
                current_index += 1;
            }
        }

        if iterations >= max_iterations {
            warn!("Maximum iteration count reached. Possible infinite fallback loop detected.");
        }

        let total_duration = (chrono::Utc::now() - start_time).num_milliseconds();

        // Determine final status - executed_without_error, executed_with_error, or cancelled
        let final_status = if cancelled_by_user {
            "cancelled"
        } else if !sequence_had_errors {
            "executed_without_error"
        } else {
            "executed_with_error"
        };
        info!(
            log_source = %log_source,
            execution_id = %execution_id_val,
            trace_id = %trace_id_val,
            status = %final_status,
            executed_tools = %actually_executed_count,
            total_results = %results.len(),
            total_duration_ms = %total_duration,
            cancelled = %cancelled_by_user,
            "execute_sequence completed"
        );

        // Get predicted execution log paths (will be written by call_tool after this returns)
        // Use folder name extracted from URL for consistent file paths
        let workflow_folder = args
            .url
            .as_deref()
            .and_then(extract_workflow_folder_from_url);
        let log_paths = execution_logger::get_predicted_log_paths(
            workflow_folder.as_deref(),
            args.start_from_step.as_deref(),
            "execute_sequence",
        );

        let mut summary = json!({
            "action": "execute_ts_workflow",
            "status": final_status,
            "total_tools": sequence_items.len(),
            "executed_tools": actually_executed_count,
            "total_results": results.len(),
            "total_duration_ms": total_duration,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "used_fallback": used_fallback,
            "results": results,
            "env": execution_context_map.get("env").cloned().unwrap_or_else(|| json!({})),
            "execution_log_path": log_paths.json_path,
            "typescript_snippet_path": log_paths.ts_path,
        });

        // Support both 'output_parser' (legacy) and 'output' (simplified)
        let parser_def = args.output_parser.as_ref().or(args.output.as_ref());

        // Skip output parser when end_at_step is specified (partial execution)
        if let Some(parser_def) = parser_def {
            if args.end_at_step.is_some() {
                warn!(
                    "Skipping output parser for partial workflow execution (end_at_step specified)"
                );
                if let Some(obj) = summary.as_object_mut() {
                    obj.insert(
                        "parser_skipped".to_string(),
                        json!("Partial execution with end_at_step"),
                    );
                }
            } else {
                // Apply variable substitution to the output_parser field
                let mut parser_json = parser_def.clone();
                let execution_context =
                    Self::create_flattened_execution_context(&execution_context_map);
                substitute_variables(&mut parser_json, &execution_context);

                match output_parser::run_output_parser(&parser_json, &summary).await {
                    Ok(Some(parsed_data)) => {
                        // Check if the parsed data is wrapped in a 'result' field and unwrap it
                        // This handles the case where JavaScript execution via scripting_engine returns
                        // {result: <actual_parser_output>, logs: [...]} wrapper structure.
                        // We need to extract the actual parser output from the wrapper to ensure
                        // the CLI and downstream consumers receive the parser's intended structure.
                        let final_data = if let Some(result) = parsed_data.get("result") {
                            // Log that we're unwrapping for debugging visibility
                            info!(
                            "[output_parser] Unwrapping parser result from JavaScript execution wrapper"
                        );
                            // Unwrap the result field to get the actual parser output
                            result.clone()
                        } else {
                            // Use as-is if not wrapped (backward compatibility with direct returns)
                            parsed_data
                        };

                        if let Some(obj) = summary.as_object_mut() {
                            obj.insert("parsed_output".to_string(), final_data);
                        }
                    }
                    Ok(None) => {
                        if let Some(obj) = summary.as_object_mut() {
                            obj.insert("parsed_output".to_string(), json!({}));
                        }
                    }
                    Err(e) => {
                        if let Some(obj) = summary.as_object_mut() {
                            obj.insert("parser_error".to_string(), json!(e.to_string()));
                        }
                    }
                }
            }
        }
        if final_status != "executed_without_error" {
            // Capture minimal structured debug info so failures are not opaque
            let debug_info = json!({
                "final_status": final_status,
                "had_critical_error": critical_error_occurred,
                "had_errors": sequence_had_errors,
                "used_fallback": used_fallback,
                "executed_count": actually_executed_count,
                "total_results": results.len(),
            });

            if let Some(obj) = summary.as_object_mut() {
                obj.insert("debug_info_on_failure".to_string(), debug_info);
            }
        }

        let contents = vec![Content::json(summary.clone())?];

        // End workflow span with appropriate status
        let span_success = matches!(final_status, "executed_without_error");
        let span_message = if span_success {
            "Workflow completed successfully"
        } else {
            "Workflow failed"
        };

        workflow_span.set_status(span_success, span_message);
        workflow_span.add_event(
            "workflow.completed",
            vec![
                ("workflow.total_steps", results.len().to_string()),
                ("workflow.final_status", final_status.to_string()),
                ("workflow.used_fallback", used_fallback.to_string()),
            ],
        );
        workflow_span.end();

        // Restore windows after sequence completion (success or failure)
        // This ensures windows are restored even if sequence fails mid-execution
        if window_mgmt_enabled {
            if let Err(e) = self.window_manager.restore_all_windows().await {
                tracing::warn!("Failed to restore windows after sequence: {}", e);
            } else {
                tracing::info!("Restored all windows to original state after sequence");
            }
            self.window_manager.clear_captured_state().await;
        } else {
            tracing::debug!("Window management disabled for sequence, skipping restore");
        }

        Ok(CallToolResult::success(contents))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn execute_single_tool(
        &self,
        peer: Peer<RoleServer>,
        request_context: RequestContext<RoleServer>,
        tool_name: &str,
        arguments: &Value,
        is_skippable: bool,
        index: usize,
        include_detailed: bool,
        step_id: Option<&str>,
        execution_context: Option<crate::utils::ToolExecutionContext>,
    ) -> (serde_json::Value, bool) {
        let tool_start_time = chrono::Utc::now();
        let tool_name_short = tool_name
            .strip_prefix("mcp_computeruse-mcp-agent_")
            .unwrap_or(tool_name);

        // Start log capture if in verbose mode
        if include_detailed {
            if let Some(ref log_capture) = self.log_capture {
                log_capture.start_capture();
            }
        }

        // The substitution is handled in `execute_sequence_impl`.
        let tool_result = self
            .dispatch_tool(
                peer,
                request_context,
                tool_name_short,
                arguments,
                execution_context,
            )
            .await;

        let (processed_result, error_occurred) = match tool_result {
            Ok(result) => {
                let mut extracted_content = Vec::new();

                if !result.content.is_empty() {
                    for content in &result.content {
                        match extract_content_json(content) {
                            Ok(json_content) => extracted_content.push(json_content),
                            Err(_) => extracted_content.push(
                                json!({ "type": "unknown", "data": "Content extraction failed" }),
                            ),
                        }
                    }
                }

                let content_count = result.content.len();
                let content_summary = if include_detailed {
                    // Verbose mode: include full content/step definitions
                    json!({ "type": "tool_result", "content_count": content_count, "content": extracted_content })
                } else {
                    // Normal/quiet mode: include extracted content (logs/output) but not step definitions
                    // The extracted_content already contains just the results, not the tool arguments/definitions
                    json!({
                        "type": "tool_result",
                        "status": "executed_without_error",
                        "content_count": content_count,
                        "content": extracted_content
                    })
                };
                let duration_ms = (chrono::Utc::now() - tool_start_time).num_milliseconds();
                let mut result_json = json!({
                    "tool_name": tool_name,
                    "index": index,
                    "status": "executed_without_error",
                    "duration_ms": duration_ms,
                    "result": content_summary,
                });

                // Add step_id if provided
                if let Some(id) = step_id {
                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("step_id".to_string(), json!(id));
                    }
                }

                // Capture server logs if in verbose mode
                if include_detailed {
                    if let Some(ref log_capture) = self.log_capture {
                        let captured_logs = log_capture.stop_capture();
                        if !captured_logs.is_empty() {
                            if let Some(obj) = result_json.as_object_mut() {
                                obj.insert("server_logs".to_string(), json!(captured_logs));
                            }
                        }
                    }
                }

                // Extract and add logs if present (for run_command)
                if tool_name_short == "run_command" {
                    // Debug: log what's in extracted content
                    for (i, content) in extracted_content.iter().enumerate() {
                        if let Some(logs) = content.get("logs") {
                            info!(
                                "[execute_single_tool] Found logs in content[{}]: {} entries",
                                i,
                                logs.as_array().map(|a| a.len()).unwrap_or(0)
                            );
                        }
                    }

                    // Look for logs in the extracted content
                    if let Some(logs) = extracted_content
                        .iter()
                        .find_map(|c| c.get("logs").cloned())
                    {
                        info!("[execute_single_tool] Adding logs to result_json");
                        if let Some(obj) = result_json.as_object_mut() {
                            obj.insert("logs".to_string(), logs);
                        }
                    } else {
                        info!("[execute_single_tool] No logs found in extracted content");
                    }
                }

                let result_json =
                    serde_json::Value::Object(result_json.as_object().unwrap().clone());
                (result_json, false)
            }
            Err(e) => {
                // Stop log capture on error and collect logs
                let captured_logs = if include_detailed {
                    self.log_capture
                        .as_ref()
                        .map(|log_capture| log_capture.stop_capture())
                } else {
                    None
                };

                let duration_ms = (chrono::Utc::now() - tool_start_time).num_milliseconds();
                let mut error_result = json!({
                    "tool_name": tool_name,
                    "index": index,
                    "status": if is_skippable { "skipped" } else { "error" },
                    "duration_ms": duration_ms,
                    "error": format!("{}", e),
                });

                // Include server logs in error result if captured
                if let Some(logs) = captured_logs {
                    if !logs.is_empty() {
                        if let Some(obj) = error_result.as_object_mut() {
                            obj.insert("server_logs".to_string(), json!(logs));
                        }
                    }
                }

                // Add step_id if provided
                if let Some(id) = step_id {
                    if let Some(obj) = error_result.as_object_mut() {
                        obj.insert("step_id".to_string(), json!(id));
                    }
                }

                let error_result =
                    serde_json::Value::Object(error_result.as_object().unwrap().clone());

                if !is_skippable {
                    warn!(
                        "Tool '{}' at index {} failed. Reason: {}",
                        tool_name, index, e
                    );
                }
                (error_result, !is_skippable)
            }
        };

        (processed_result, error_occurred)
    }

    /// Execute TypeScript workflow with MCP notification streaming
    async fn execute_typescript_workflow(
        &self,
        url: &str,
        args: ExecuteSequenceArgs,
        execution_id: String,
        peer: Peer<RoleServer>,
        client_progress_token: Option<ProgressToken>,
    ) -> Result<CallToolResult, McpError> {
        // Extract trace context for distributed tracing
        let trace_id_val = args.trace_id.clone().unwrap_or_default();
        let execution_id_val = args
            .execution_id
            .clone()
            .unwrap_or_else(|| execution_id.clone());

        // Create tracing span with execution context
        // All nested logs (including from TypeScript workflow stderr) will inherit this context
        let workflow_span = info_span!(
            "execute_typescript_workflow",
            trace_id = %trace_id_val,
            execution_id = %execution_id_val,
            log_source = "agent",
            url = %url,
        );

        // Log start with execution context for ClickHouse filtering
        info!(
            log_source = "agent",
            execution_id = %execution_id_val,
            trace_id = %trace_id_val,
            url = %url,
            "Starting TypeScript workflow execution [execution_id={}, trace_id={}]",
            execution_id_val, trace_id_val
        );

        // Execute within the span context so all nested logs inherit execution_id/trace_id
        async move {
            // Load saved state if resuming
            let restored_state = if args.start_from_step.is_some() {
                Self::load_workflow_state(args.workflow_id.as_deref(), Some(url)).await?
            } else {
                None
            };

            // Create TypeScript workflow executor
            let ts_workflow = TypeScriptWorkflow::new(url)?;

            // Create event channel for streaming workflow events to MCP client
            let (event_tx, mut event_rx) = mpsc::unbounded_channel::<WorkflowEvent>();

            // Use client's progress token if provided, otherwise generate one
            info!(
                "client_progress_token received: {:?}",
                client_progress_token
            );
            let progress_token = client_progress_token.unwrap_or_else(|| {
                ProgressToken(NumberOrString::String(
                    format!("workflow-{}", execution_id_val).into(),
                ))
            });

            // Shared storage for collecting screenshots from events with metadata
            // (index, timestamp, annotation, element, base64)
            #[allow(clippy::type_complexity)]
            let collected_screenshots: Arc<
                std::sync::Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
            > = Arc::new(std::sync::Mutex::new(Vec::new()));
            let screenshots_clone = collected_screenshots.clone();

            // Spawn task to forward events as MCP notifications
            let peer_clone = peer.clone();
            let progress_token_clone = progress_token.clone();
            let notification_handle = tokio::spawn(async move {
                let mut step_counter: u32 = 0;
                let mut total_steps: Option<u32> = None;
                let mut screenshot_index: usize = 0;

                while let Some(event) = event_rx.recv().await {
                    match event {
                        WorkflowEvent::Progress {
                            current,
                            total,
                            message,
                            ..
                        } => {
                            // Send MCP progress notification
                            let _ = peer_clone
                                .notify_progress(ProgressNotificationParam {
                                    progress_token: progress_token_clone.clone(),
                                    progress: current,
                                    total,
                                    message,
                                })
                                .await;
                        }
                        WorkflowEvent::StepStarted {
                            step_name,
                            step_index,
                            total_steps: steps_total,
                            ..
                        } => {
                            step_counter = step_index.unwrap_or(step_counter + 1);
                            if let Some(t) = steps_total {
                                total_steps = Some(t);
                            }
                            // Send as logging message for clients that support it
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: LoggingLevel::Info,
                                    logger: Some("workflow".to_string()),
                                    data: json!({
                                        "type": "step_started",
                                        "step": step_counter,
                                        "total": total_steps,
                                        "name": step_name
                                    }),
                                })
                                .await;
                            // Also send as progress notification
                            let _ = peer_clone
                                .notify_progress(ProgressNotificationParam {
                                    progress_token: progress_token_clone.clone(),
                                    progress: step_counter as f64,
                                    total: total_steps.map(|t| t as f64),
                                    message: Some(format!("Starting: {}", step_name)),
                                })
                                .await;
                        }
                        WorkflowEvent::StepCompleted {
                            step_name,
                            duration,
                            step_index,
                            ..
                        } => {
                            let step = step_index.unwrap_or(step_counter);
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: LoggingLevel::Info,
                                    logger: Some("workflow".to_string()),
                                    data: json!({
                                        "type": "step_completed",
                                        "step": step,
                                        "name": step_name,
                                        "duration_ms": duration
                                    }),
                                })
                                .await;
                        }
                        WorkflowEvent::StepFailed {
                            step_name, error, ..
                        } => {
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: LoggingLevel::Error,
                                    logger: Some("workflow".to_string()),
                                    data: json!({
                                        "type": "step_failed",
                                        "name": step_name,
                                        "error": error
                                    }),
                                })
                                .await;
                        }
                        WorkflowEvent::Log {
                            level,
                            message,
                            data,
                            ..
                        } => {
                            let log_level = match level.as_str() {
                                "error" => LoggingLevel::Error,
                                "warn" | "warning" => LoggingLevel::Warning,
                                "debug" => LoggingLevel::Debug,
                                _ => LoggingLevel::Info,
                            };
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: log_level,
                                    logger: Some("workflow".to_string()),
                                    data: data.unwrap_or_else(|| json!({ "message": message })),
                                })
                                .await;
                        }
                        WorkflowEvent::Data { key, value, .. } => {
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: LoggingLevel::Info,
                                    logger: Some("workflow.data".to_string()),
                                    data: json!({ "key": key, "value": value }),
                                })
                                .await;
                        }
                        WorkflowEvent::Screenshot {
                            path,
                            base64,
                            annotation,
                            element,
                            timestamp,
                        } => {
                            // Collect base64 screenshots with metadata for inclusion in the result
                            if let Some(ref b64) = base64 {
                                if let Ok(mut screenshots) = screenshots_clone.lock() {
                                    screenshots.push((
                                        screenshot_index,
                                        timestamp.clone(),
                                        annotation.clone(),
                                        element.clone(),
                                        b64.clone(),
                                    ));
                                    screenshot_index += 1;
                                }
                            }
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: LoggingLevel::Info,
                                    logger: Some("workflow.screenshot".to_string()),
                                    data: json!({
                                        "type": "screenshot",
                                        "path": path,
                                        "annotation": annotation,
                                        "index": screenshot_index.saturating_sub(1)
                                    }),
                                })
                                .await;
                        }
                        WorkflowEvent::Status {
                            text,
                            duration_ms,
                            position,
                            timestamp,
                        } => {
                            let _ = peer_clone
                                .notify_logging_message(LoggingMessageNotificationParam {
                                    level: LoggingLevel::Info,
                                    logger: Some("workflow.status".to_string()),
                                    data: json!({
                                        "text": text,
                                        "durationMs": duration_ms,
                                        "position": position,
                                        "timestamp": timestamp
                                    }),
                                })
                                .await;
                        }
                    }
                }
            });

            // Execute workflow with event streaming
            // Extract folder from URL for SDK screenshot storage
            let workflow_folder = extract_workflow_folder_from_url(url);
            let result = ts_workflow
                .execute_with_events(
                    args.inputs.unwrap_or(json!({})),
                    args.start_from_step.as_deref(),
                    args.end_at_step.as_deref(),
                    restored_state,
                    Some(&execution_id_val),
                    Some(event_tx),
                    workflow_folder.as_deref(),
                )
                .await?;

            // Wait for notification handler to finish (it will exit when sender is dropped)
            let _ = notification_handle.await;

            // Save state for resumption (only if last_step_index is provided by runner-based workflows)
            if let (Some(ref last_step_id), Some(last_step_index)) = (
                &result.result.result.last_step_id,
                result.result.result.last_step_index,
            ) {
                Self::save_workflow_state(
                    args.workflow_id.as_deref(),
                    Some(url),
                    Some(last_step_id),
                    last_step_index,
                    &result.result.state,
                )
                .await?;
            }

            // Get predicted execution log paths (will be written by call_tool after this returns)
            // Use folder name extracted from URL for consistent file paths
            let workflow_folder = extract_workflow_folder_from_url(url);
            let log_paths = execution_logger::get_predicted_log_paths(
                workflow_folder.as_deref(),
                args.start_from_step.as_deref(),
                "execute_sequence",
            );

            // Return result
            let mut output = json!({
                "status": result.result.result.status,
                "message": result.result.result.message,
                "data": result.result.result.data,
                "metadata": result.result.metadata,
                "state": result.result.state,
                "last_step_id": result.result.result.last_step_id,
                "last_step_index": result.result.result.last_step_index,
                "execution_log_path": log_paths.json_path,
                "typescript_snippet_path": log_paths.ts_path,
            });

            // If there's data from context.data, add it as parsed_output for CLI compatibility
            if let Some(data) = &result.result.result.data {
                if !data.is_null() {
                    if let Some(obj) = output.as_object_mut() {
                        obj.insert(
                            "parsed_output".to_string(),
                            json!({
                                "data": data
                            }),
                        );
                    }
                }
            }

            // Restore windows after TypeScript workflow completion (success or failure)
            let window_mgmt_enabled = args.window_mgmt.enable_window_management.unwrap_or(true);
            if window_mgmt_enabled {
                if let Err(e) = self.window_manager.restore_all_windows().await {
                    tracing::warn!("Failed to restore windows after TypeScript workflow: {}", e);
                } else {
                    tracing::info!(
                        "Restored all windows to original state after TypeScript workflow"
                    );
                }
                self.window_manager.clear_captured_state().await;
            } else {
                tracing::debug!(
                    "Window management disabled for TypeScript workflow, skipping restore"
                );
            }

            // Store captured stderr logs for dispatch_tool to include in execution log
            if let Ok(mut logs) = self.captured_stderr_logs.lock() {
                logs.clear();
                logs.extend(result.logs);
            }

            // Build content with JSON response and any collected screenshots
            // Add screenshot metadata to output for ordering context
            if let Ok(screenshots) = collected_screenshots.lock() {
                if !screenshots.is_empty() {
                    let screenshot_metadata: Vec<serde_json::Value> = screenshots
                        .iter()
                        .map(|(idx, ts, annotation, element, _)| {
                            json!({
                                "index": idx,
                                "timestamp": ts,
                                "annotation": annotation,
                                "element": element
                            })
                        })
                        .collect();
                    output["screenshots"] = json!(screenshot_metadata);
                }
            }

            let mut contents = vec![Content::text(
                serde_json::to_string_pretty(&output).unwrap(),
            )];

            // Append collected screenshots as image content for MCP vision support (in order)
            if let Ok(screenshots) = collected_screenshots.lock() {
                for (_, _, _, _, base64_image) in screenshots.iter() {
                    contents.push(Content::image(
                        base64_image.clone(),
                        "image/png".to_string(),
                    ));
                }
                if !screenshots.is_empty() {
                    info!(
                        "[execute_sequence] Appended {} screenshots to response",
                        screenshots.len()
                    );
                }
            }

            Ok(CallToolResult {
                content: contents,
                is_error: Some(result.result.result.status != "executed_without_error"),
                meta: None,
                structured_content: None,
            })
        }
        .instrument(workflow_span)
        .await
    }
}
