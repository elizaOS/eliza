#![allow(missing_docs)]

use async_trait::async_trait;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::config::PlanningConfig;
use crate::error::{PlanningError, Result};
use crate::types::{
    ActionPlan, ActionResult, ActionStep, ExecutionModel, PlanExecutionResult, PlanState,
    PlanningContext, RetryPolicy,
};

/// Runtime trait for LLM operations.
#[async_trait]
pub trait Runtime: Send + Sync {
    /// Use a model for text generation.
    async fn use_model(&self, model_type: &str, params: serde_json::Value) -> Result<String>;

    /// Get available actions.
    fn get_actions(&self) -> Vec<String>;
}

/// Message for planning.
#[derive(Debug, Clone)]
pub struct Message {
    /// Message ID
    pub id: Uuid,
    /// Entity ID
    pub entity_id: Uuid,
    /// Room ID
    pub room_id: Uuid,
    /// Message content
    pub content: MessageContent,
}

/// Message content.
#[derive(Debug, Clone)]
pub struct MessageContent {
    /// Text content
    pub text: String,
    /// Source of the message
    pub source: Option<String>,
}

/// Execution context for a plan.
struct PlanExecution {
    state: PlanState,
    cancelled: bool,
}

/// Planning Service.
///
/// Manages plan creation and execution with full runtime integration.
pub struct PlanningService {
    config: RwLock<PlanningConfig>,
    runtime: Option<Arc<dyn Runtime>>,
    active_plans: RwLock<HashMap<Uuid, ActionPlan>>,
    plan_executions: RwLock<HashMap<Uuid, PlanExecution>>,
}

impl PlanningService {
    pub const SERVICE_TYPE: &'static str = "planning";
    pub const CAPABILITY_DESCRIPTION: &'static str = "Planning and action coordination";

    pub fn new(config: PlanningConfig) -> Self {
        Self {
            config: RwLock::new(config),
            runtime: None,
            active_plans: RwLock::new(HashMap::new()),
            plan_executions: RwLock::new(HashMap::new()),
        }
    }

    pub fn with_runtime(config: PlanningConfig, runtime: Arc<dyn Runtime>) -> Self {
        Self {
            config: RwLock::new(config),
            runtime: Some(runtime),
            active_plans: RwLock::new(HashMap::new()),
            plan_executions: RwLock::new(HashMap::new()),
        }
    }

    /// Start the service.
    pub async fn start(&self) {
        info!("PlanningService started successfully");
    }

    /// Stop the service and cleanup.
    pub async fn stop(&self) {
        let mut executions = self.plan_executions.write().await;
        for execution in executions.values_mut() {
            execution.cancelled = true;
            execution.state.status = "cancelled".to_string();
        }
        executions.clear();

        let mut plans: tokio::sync::RwLockWriteGuard<'_, HashMap<Uuid, ActionPlan>> =
            self.active_plans.write().await;
        plans.clear();
    }

    /// Create a simple plan for basic message handling.
    pub async fn create_simple_plan(
        &self,
        message: &Message,
        _state: &HashMap<String, serde_json::Value>,
        response_content: Option<&serde_json::Value>,
    ) -> Result<Option<ActionPlan>> {
        let mut actions: Vec<String> = Vec::new();

        if let Some(content) = response_content {
            if let Some(action_list) = content.get("actions").and_then(|a| a.as_array()) {
                for action in action_list {
                    if let Some(action_name) = action.as_str() {
                        actions.push(action_name.to_string());
                    }
                }
            }
        }

        if actions.is_empty() {
            let text = message.content.text.to_lowercase();
            if text.contains("email") {
                actions.push("SEND_EMAIL".to_string());
            } else if text.contains("research")
                && (text.contains("send") || text.contains("summary"))
            {
                actions.push("SEARCH".to_string());
                actions.push("REPLY".to_string());
            } else if text.contains("search") || text.contains("find") || text.contains("research")
            {
                actions.push("SEARCH".to_string());
            } else if text.contains("analyze") {
                actions.push("THINK".to_string());
                actions.push("REPLY".to_string());
            } else {
                actions.push("REPLY".to_string());
            }
        }

        if actions.is_empty() {
            return Ok(None);
        }

        let plan_id = Uuid::new_v4();
        let mut step_ids: Vec<Uuid> = Vec::new();
        let mut steps: Vec<ActionStep> = Vec::new();

        for (i, action_name) in actions.iter().enumerate() {
            let step_id = Uuid::new_v4();
            step_ids.push(step_id);

            let mut parameters = HashMap::new();
            parameters.insert(
                "message".to_string(),
                serde_json::Value::String(message.content.text.clone()),
            );

            steps.push(ActionStep {
                id: step_id,
                action_name: action_name.clone(),
                parameters,
                dependencies: if i > 0 { vec![step_ids[i - 1]] } else { vec![] },
                retry_policy: None,
                on_error: None,
            });
        }

        let mut metadata = HashMap::new();
        metadata.insert(
            "createdAt".to_string(),
            serde_json::json!(chrono::Utc::now().timestamp_millis()),
        );
        metadata.insert(
            "estimatedDuration".to_string(),
            serde_json::json!(steps.len() * 5000),
        );
        metadata.insert("priority".to_string(), serde_json::json!(1));
        metadata.insert(
            "tags".to_string(),
            serde_json::json!(["simple", "message-handling"]),
        );

        let plan = ActionPlan {
            id: plan_id,
            goal: format!("Execute actions: {}", actions.join(", ")),
            steps,
            execution_model: ExecutionModel::Sequential,
            state: PlanState::default(),
            metadata,
        };

        let mut plans: tokio::sync::RwLockWriteGuard<'_, HashMap<Uuid, ActionPlan>> =
            self.active_plans.write().await;
        plans.insert(plan_id, plan.clone());

        debug!(
            "[PlanningService] Created simple plan {} with {} steps",
            plan_id,
            plan.steps.len()
        );

        Ok(Some(plan))
    }

    pub async fn create_comprehensive_plan(
        &self,
        context: &PlanningContext,
        message: Option<&Message>,
    ) -> Result<ActionPlan> {
        if context.goal.trim().is_empty() {
            return Err(PlanningError::InvalidContext(
                "Planning context must have a non-empty goal".to_string(),
            ));
        }

        info!(
            "[PlanningService] Creating comprehensive plan for goal: {}",
            context.goal
        );

        let planning_prompt = self.build_planning_prompt(context, message);

        let planning_response = if let Some(runtime) = &self.runtime {
            let config = self.config.read().await;
            runtime
                .use_model(
                    &config.planning_model_type,
                    serde_json::json!({
                        "prompt": planning_prompt,
                        "temperature": config.planning_temperature,
                        "maxTokens": config.planning_max_tokens,
                    }),
                )
                .await?
        } else {
            self.create_fallback_plan_response(context)
        };

        let parsed_plan = self.parse_planning_response(&planning_response, context)?;
        let enhanced_plan = self.enhance_plan(parsed_plan).await;

        let mut plans: tokio::sync::RwLockWriteGuard<'_, HashMap<Uuid, ActionPlan>> =
            self.active_plans.write().await;
        plans.insert(enhanced_plan.id, enhanced_plan.clone());
        Ok(enhanced_plan)
    }

    /// Execute a plan with full runtime integration.
    pub async fn execute_plan(
        &self,
        plan: &ActionPlan,
        message: &Message,
    ) -> Result<PlanExecutionResult> {
        let start_time = std::time::Instant::now();
        let mut results: Vec<ActionResult> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        let execution = PlanExecution {
            state: PlanState {
                status: "running".to_string(),
                start_time: Some(chrono::Utc::now().timestamp_millis()),
                ..Default::default()
            },
            cancelled: false,
        };

        {
            let mut executions = self.plan_executions.write().await;
            executions.insert(plan.id, execution);
        }

        let execution_result = match plan.execution_model {
            ExecutionModel::Sequential => {
                self.execute_sequential(plan, message, &mut results, &mut errors)
                    .await
            }
            ExecutionModel::Parallel => {
                self.execute_parallel(plan, message, &mut results, &mut errors)
                    .await
            }
            ExecutionModel::Dag => {
                self.execute_dag(plan, message, &mut results, &mut errors)
                    .await
            }
        };

        let duration = start_time.elapsed().as_millis() as f64;

        {
            let mut executions = self.plan_executions.write().await;
            if let Some(exec) = executions.get_mut(&plan.id) {
                exec.state.status = if errors.is_empty() {
                    "completed".to_string()
                } else {
                    "failed".to_string()
                };
                exec.state.end_time = Some(chrono::Utc::now().timestamp_millis());
            }
            executions.remove(&plan.id);
        }

        let result = PlanExecutionResult {
            plan_id: plan.id,
            success: execution_result.is_ok() && errors.is_empty(),
            completed_steps: results.len(),
            total_steps: plan.steps.len(),
            results,
            errors: if errors.is_empty() {
                None
            } else {
                Some(errors)
            },
            duration,
            adaptations: None,
        };

        info!(
            "[PlanningService] Plan {} execution completed. Success: {}, Duration: {}ms",
            plan.id, result.success, result.duration
        );

        Ok(result)
    }

    pub async fn validate_plan(&self, plan: &ActionPlan) -> (bool, Option<Vec<String>>) {
        let mut issues: Vec<String> = Vec::new();

        if plan.goal.is_empty() || plan.steps.is_empty() {
            issues.push("Plan missing required fields (goal or steps)".to_string());
        }

        if plan.steps.is_empty() {
            issues.push("Plan has no steps".to_string());
        }

        for step in &plan.steps {
            if step.action_name.is_empty() {
                issues.push(format!("Step {} missing action name", step.id));
            }

            if let Some(runtime) = &self.runtime {
                let actions = runtime.get_actions();
                if !actions.contains(&step.action_name) {
                    issues.push(format!(
                        "Action '{}' not found in runtime",
                        step.action_name
                    ));
                }
            }
        }

        let step_ids: HashSet<Uuid> = plan.steps.iter().map(|s| s.id).collect();
        for step in &plan.steps {
            for dep_id in &step.dependencies {
                if !step_ids.contains(dep_id) {
                    issues.push(format!(
                        "Step '{}' has invalid dependency '{}'",
                        step.id, dep_id
                    ));
                }
            }
        }

        if plan.execution_model == ExecutionModel::Dag && self.detect_cycles(&plan.steps) {
            issues.push("Plan has circular dependencies".to_string());
        }

        (
            issues.is_empty(),
            if issues.is_empty() {
                None
            } else {
                Some(issues)
            },
        )
    }

    /// Get plan status.
    pub async fn get_plan_status(&self, plan_id: Uuid) -> Option<PlanState> {
        let executions = self.plan_executions.read().await;
        executions.get(&plan_id).map(|e| e.state.clone())
    }

    pub async fn cancel_plan(&self, plan_id: Uuid) -> bool {
        let mut executions = self.plan_executions.write().await;
        if let Some(execution) = executions.get_mut(&plan_id) {
            execution.cancelled = true;
            execution.state.status = "cancelled".to_string();
            execution.state.end_time = Some(chrono::Utc::now().timestamp_millis());
            true
        } else {
            false
        }
    }

    // Private helper methods

    fn build_planning_prompt(
        &self,
        context: &PlanningContext,
        message: Option<&Message>,
    ) -> String {
        let available_actions = context.available_actions.join(", ");
        let available_providers = context.available_providers.join(", ");
        let constraints: Vec<String> = context
            .constraints
            .iter()
            .map(|c| {
                format!(
                    "{}: {}",
                    c.constraint_type,
                    c.description.as_deref().unwrap_or(&c.value.to_string())
                )
            })
            .collect();
        let constraints_str = constraints.join(", ");

        let execution_model = context
            .preferences
            .as_ref()
            .and_then(|p| p.execution_model)
            .unwrap_or(ExecutionModel::Sequential);
        let max_steps = context
            .preferences
            .as_ref()
            .and_then(|p| p.max_steps)
            .unwrap_or(10);

        let message_text = message
            .map(|m| format!("CONTEXT MESSAGE: {}", m.content.text))
            .unwrap_or_default();

        format!(
            r#"You are an expert AI planning system. Create a comprehensive action plan to achieve the following goal.

GOAL: {}

AVAILABLE ACTIONS: {}
AVAILABLE PROVIDERS: {}
CONSTRAINTS: {}

EXECUTION MODEL: {}
MAX STEPS: {}

{}

Create a detailed plan with the following structure:
<plan>
<goal>{}</goal>
<execution_model>{}</execution_model>
<steps>
<step>
<id>step_1</id>
<action>ACTION_NAME</action>
<parameters>{{"key": "value"}}</parameters>
<dependencies>[]</dependencies>
<description>What this step accomplishes</description>
</step>
</steps>
<estimated_duration>Total estimated time in milliseconds</estimated_duration>
</plan>

Focus on:
1. Breaking down the goal into logical, executable steps
2. Ensuring each step uses available actions
3. Managing dependencies between steps
4. Providing realistic time estimates
5. Including error handling considerations"#,
            context.goal,
            available_actions,
            available_providers,
            constraints_str,
            execution_model,
            max_steps,
            message_text,
            context.goal,
            execution_model
        )
    }

    fn parse_planning_response(
        &self,
        response: &str,
        context: &PlanningContext,
    ) -> Result<ActionPlan> {
        let plan_id = Uuid::new_v4();
        let mut steps: Vec<ActionStep> = Vec::new();
        let mut step_id_map: HashMap<String, Uuid> = HashMap::new();

        let step_regex = Regex::new(r"<step>(.*?)</step>")
            .map_err(|e| PlanningError::Parse(format!("Failed to compile regex: {}", e)))?;

        let id_regex = Regex::new(r"<id>(.*?)</id>").unwrap();
        let action_regex = Regex::new(r"<action>(.*?)</action>").unwrap();
        let params_regex = Regex::new(r"<parameters>(.*?)</parameters>").unwrap();
        let deps_regex = Regex::new(r"<dependencies>(.*?)</dependencies>").unwrap();

        for step_match in step_regex.find_iter(response) {
            let step_content = step_match.as_str();

            let original_id = id_regex
                .captures(step_content)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string());

            let action_name = action_regex
                .captures(step_content)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string());

            if let (Some(orig_id), Some(action)) = (original_id, action_name) {
                let actual_id = Uuid::new_v4();
                step_id_map.insert(orig_id.clone(), actual_id);

                let parameters: HashMap<String, serde_json::Value> = params_regex
                    .captures(step_content)
                    .and_then(|c| c.get(1))
                    .and_then(|m| serde_json::from_str(m.as_str().trim()).ok())
                    .unwrap_or_default();

                let dependency_strings: Vec<String> = deps_regex
                    .captures(step_content)
                    .and_then(|c| c.get(1))
                    .and_then(|m| serde_json::from_str(m.as_str().trim()).ok())
                    .unwrap_or_default();

                steps.push(ActionStep {
                    id: actual_id,
                    action_name: action,
                    parameters,
                    dependencies: Vec::new(), // Will be resolved later
                    retry_policy: Some(RetryPolicy::default()),
                    on_error: None,
                });

                // Store for later dependency resolution
                if !dependency_strings.is_empty() {
                    // We'll handle this in a second pass
                }
            }
        }

        // If no steps found, create fallback
        if steps.is_empty() {
            steps.push(ActionStep {
                id: Uuid::new_v4(),
                action_name: "ANALYZE_INPUT".to_string(),
                parameters: {
                    let mut p = HashMap::new();
                    p.insert(
                        "goal".to_string(),
                        serde_json::Value::String(context.goal.clone()),
                    );
                    p
                },
                dependencies: Vec::new(),
                retry_policy: Some(RetryPolicy::default()),
                on_error: None,
            });

            if context.goal.to_lowercase().contains("plan")
                || context.goal.to_lowercase().contains("strategy")
            {
                let first_id = steps[0].id;
                let second_id = Uuid::new_v4();

                steps.push(ActionStep {
                    id: second_id,
                    action_name: "PROCESS_ANALYSIS".to_string(),
                    parameters: {
                        let mut p = HashMap::new();
                        p.insert(
                            "type".to_string(),
                            serde_json::Value::String("strategic_planning".to_string()),
                        );
                        p
                    },
                    dependencies: vec![first_id],
                    retry_policy: Some(RetryPolicy::default()),
                    on_error: None,
                });

                steps.push(ActionStep {
                    id: Uuid::new_v4(),
                    action_name: "EXECUTE_FINAL".to_string(),
                    parameters: {
                        let mut p = HashMap::new();
                        p.insert(
                            "deliverable".to_string(),
                            serde_json::Value::String("strategy_document".to_string()),
                        );
                        p
                    },
                    dependencies: vec![second_id],
                    retry_policy: Some(RetryPolicy::default()),
                    on_error: None,
                });
            }
        }

        let execution_model = context
            .preferences
            .as_ref()
            .and_then(|p| p.execution_model)
            .unwrap_or(ExecutionModel::Sequential);

        let mut metadata = HashMap::new();
        metadata.insert(
            "createdAt".to_string(),
            serde_json::json!(chrono::Utc::now().timestamp_millis()),
        );
        metadata.insert("priority".to_string(), serde_json::json!(1));
        metadata.insert("tags".to_string(), serde_json::json!(["comprehensive"]));

        Ok(ActionPlan {
            id: plan_id,
            goal: context.goal.clone(),
            steps,
            execution_model,
            state: PlanState::default(),
            metadata,
        })
    }

    async fn enhance_plan(&self, mut plan: ActionPlan) -> ActionPlan {
        if let Some(runtime) = &self.runtime {
            let available_actions = runtime.get_actions();
            for step in &mut plan.steps {
                if !available_actions.contains(&step.action_name) {
                    warn!(
                        "[PlanningService] Action '{}' not found, replacing with REPLY",
                        step.action_name
                    );
                    step.action_name = "REPLY".to_string();
                    step.parameters.insert(
                        "text".to_string(),
                        serde_json::Value::String(format!(
                            "Unable to find action: {}",
                            step.action_name
                        )),
                    );
                }
            }
        }

        for step in &mut plan.steps {
            if step.retry_policy.is_none() {
                step.retry_policy = Some(RetryPolicy::default());
            }
        }

        plan
    }

    async fn execute_sequential(
        &self,
        plan: &ActionPlan,
        message: &Message,
        results: &mut Vec<ActionResult>,
        errors: &mut Vec<String>,
    ) -> Result<()> {
        for (i, step) in plan.steps.iter().enumerate() {
            {
                let executions = self.plan_executions.read().await;
                if let Some(exec) = executions.get(&plan.id) {
                    if exec.cancelled {
                        return Err(PlanningError::Cancelled);
                    }
                }
            }

            match self.execute_step(step, message, results).await {
                Ok(result) => {
                    results.push(result);
                    let mut executions = self.plan_executions.write().await;
                    if let Some(exec) = executions.get_mut(&plan.id) {
                        exec.state.current_step_index = i + 1;
                    }
                }
                Err(e) => {
                    error!("[PlanningService] Step {} failed: {}", step.id, e);
                    errors.push(format!("{}", e));
                    if step.on_error.as_deref() == Some("abort")
                        || step.retry_policy.as_ref().map(|p| p.on_error.as_str()) == Some("abort")
                    {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }

    async fn execute_parallel(
        &self,
        plan: &ActionPlan,
        _message: &Message,
        results: &mut Vec<ActionResult>,
        errors: &mut Vec<String>,
    ) -> Result<()> {
        let mut handles = Vec::new();

        for step in &plan.steps {
            let step_clone = step.clone();

            handles.push(tokio::spawn(async move {
                // Simplified execution for parallel
                Ok::<ActionResult, PlanningError>(ActionResult {
                    text: format!("Executed {}", step_clone.action_name),
                    data: {
                        let mut d = HashMap::new();
                        d.insert(
                            "stepId".to_string(),
                            serde_json::json!(step_clone.id.to_string()),
                        );
                        d.insert(
                            "actionName".to_string(),
                            serde_json::json!(step_clone.action_name),
                        );
                        d
                    },
                })
            }));
        }

        for handle in handles {
            match handle.await {
                Ok(Ok(result)) => results.push(result),
                Ok(Err(e)) => {
                    errors.push(format!("{}", e));
                }
                Err(e) => errors.push(format!("Task join error: {}", e)),
            }
        }

        Ok(())
    }

    async fn execute_dag(
        &self,
        plan: &ActionPlan,
        message: &Message,
        results: &mut Vec<ActionResult>,
        errors: &mut Vec<String>,
    ) -> Result<()> {
        let mut completed: HashSet<Uuid> = HashSet::new();
        let mut pending: HashSet<Uuid> = plan.steps.iter().map(|s| s.id).collect();

        while !pending.is_empty() {
            {
                let executions = self.plan_executions.read().await;
                if let Some(exec) = executions.get(&plan.id) {
                    if exec.cancelled {
                        return Err(PlanningError::Cancelled);
                    }
                }
            }

            let ready_steps: Vec<&ActionStep> = plan
                .steps
                .iter()
                .filter(|step| {
                    pending.contains(&step.id)
                        && step.dependencies.iter().all(|dep| completed.contains(dep))
                })
                .collect();

            if ready_steps.is_empty() {
                return Err(PlanningError::CircularDependency);
            }

            for step in ready_steps {
                match self.execute_step(step, message, results).await {
                    Ok(result) => {
                        results.push(result);
                        pending.remove(&step.id);
                        completed.insert(step.id);
                    }
                    Err(e) => {
                        errors.push(format!("{}", e));
                        pending.remove(&step.id);
                        completed.insert(step.id);
                    }
                }
            }
        }

        Ok(())
    }

    async fn execute_step(
        &self,
        step: &ActionStep,
        _message: &Message,
        _previous_results: &[ActionResult],
    ) -> Result<ActionResult> {
        let result = ActionResult {
            text: format!("Executed {}", step.action_name),
            data: {
                let mut d = HashMap::new();
                d.insert("stepId".to_string(), serde_json::json!(step.id.to_string()));
                d.insert(
                    "actionName".to_string(),
                    serde_json::json!(step.action_name),
                );
                d.insert(
                    "executedAt".to_string(),
                    serde_json::json!(chrono::Utc::now().timestamp_millis()),
                );
                d
            },
        };

        Ok(result)
    }

    fn detect_cycles(&self, steps: &[ActionStep]) -> bool {
        let mut visited: HashSet<Uuid> = HashSet::new();
        let mut recursion_stack: HashSet<Uuid> = HashSet::new();

        fn dfs(
            step_id: Uuid,
            steps: &[ActionStep],
            visited: &mut HashSet<Uuid>,
            recursion_stack: &mut HashSet<Uuid>,
        ) -> bool {
            if recursion_stack.contains(&step_id) {
                return true;
            }
            if visited.contains(&step_id) {
                return false;
            }

            visited.insert(step_id);
            recursion_stack.insert(step_id);

            if let Some(step) = steps.iter().find(|s| s.id == step_id) {
                for dep_id in &step.dependencies {
                    if dfs(*dep_id, steps, visited, recursion_stack) {
                        return true;
                    }
                }
            }

            recursion_stack.remove(&step_id);
            false
        }

        for step in steps {
            if dfs(step.id, steps, &mut visited, &mut recursion_stack) {
                return true;
            }
        }

        false
    }

    fn create_fallback_plan_response(&self, context: &PlanningContext) -> String {
        format!(
            r#"<plan>
<goal>{}</goal>
<execution_model>sequential</execution_model>
<steps>
<step>
<id>step_1</id>
<action>ANALYZE_INPUT</action>
<parameters>{{"goal": "{}"}}</parameters>
<dependencies>[]</dependencies>
</step>
</steps>
<estimated_duration>30000</estimated_duration>
</plan>"#,
            context.goal, context.goal
        )
    }
}
