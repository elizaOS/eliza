//! Built-in advanced planning (gated by Character.advancedPlanning)
//!
//! Parity-oriented features:
//! - Simple plan creation (heuristic)
//! - Comprehensive plan creation (LLM-backed via `runtime.use_model`)
//! - Plan validation (action existence + dependency checks)
//! - Plan execution (sequential / parallel / DAG) using `runtime.process_selected_actions`

use crate::runtime::{AgentRuntime, Service};
use crate::types::components::ActionResult;
use crate::types::components::{
    ActionDefinition, ActionHandler, ProviderDefinition, ProviderHandler, ProviderResult,
};
use crate::types::memory::Memory;
use crate::types::model::model_type;
use crate::types::plugin::Plugin;
use crate::types::primitives::UUID;
use crate::types::state::State;
use crate::xml::parse_key_value_xml;
use anyhow::Result;
use regex::Regex;
use serde_json::Value;

// ActionParameters is a type alias for HashMap<String, Value>.
use std::any::Any;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::Mutex;
use std::sync::{Arc, Weak};

// Import template from centralized prompts
use crate::prompts::MESSAGE_CLASSIFIER_TEMPLATE;

/// Create the advanced planning plugin (actions/providers) bound to a runtime.
pub fn create_advanced_planning_plugin(runtime: Weak<AgentRuntime>) -> Plugin {
    let mut plugin = Plugin::new(
        "advanced-planning",
        "Built-in advanced planning and execution capabilities",
    );

    plugin.action_handlers.push(Arc::new(AnalyzeInputAction));
    plugin.action_handlers.push(Arc::new(ProcessAnalysisAction));
    plugin.action_handlers.push(Arc::new(ExecuteFinalAction));
    plugin.action_handlers.push(Arc::new(CreatePlanAction));
    plugin
        .provider_handlers
        .push(Arc::new(MessageClassifierProvider { runtime }));

    // Keep definitions in sync for serialization.
    plugin.definition.actions = Some(vec![
        AnalyzeInputAction::definition_static(),
        ProcessAnalysisAction::definition_static(),
        ExecuteFinalAction::definition_static(),
        CreatePlanAction::definition_static(),
    ]);
    plugin.definition.providers = Some(vec![MessageClassifierProvider::definition_static()]);

    plugin
}

struct MessageClassifierProvider {
    runtime: Weak<AgentRuntime>,
}

impl MessageClassifierProvider {
    fn definition_static() -> ProviderDefinition {
        ProviderDefinition {
            name: "messageClassifier".to_string(),
            description: Some(
                "Classifies messages by complexity and planning requirements".to_string(),
            ),
            dynamic: Some(false),
            position: None,
            private: None,
        }
    }
}

#[async_trait::async_trait]
impl ProviderHandler for MessageClassifierProvider {
    fn definition(&self) -> ProviderDefinition {
        Self::definition_static()
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult, anyhow::Error> {
        let text = message.content.text.clone().unwrap_or_default();
        if text.trim().is_empty() {
            let mut data = HashMap::new();
            data.insert(
                "classification".to_string(),
                Value::String("general".to_string()),
            );
            data.insert(
                "confidence".to_string(),
                Value::Number(serde_json::Number::from_f64(0.1).unwrap()),
            );
            data.insert(
                "complexity".to_string(),
                Value::String("simple".to_string()),
            );
            data.insert("planningRequired".to_string(), Value::Bool(false));
            data.insert("stakeholders".to_string(), Value::Array(vec![]));
            data.insert("constraints".to_string(), Value::Array(vec![]));
            return Ok(ProviderResult {
                text: Some("Message classified as: general (empty message)".to_string()),
                values: None,
                data: Some(data),
            });
        }

        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };

        let prompt = MESSAGE_CLASSIFIER_TEMPLATE.replace("{{text}}", &text);
        let response = rt
            .use_model(
                "TEXT_SMALL",
                serde_json::json!({
                    "prompt": prompt,
                    "temperature": 0.3,
                    "maxTokens": 300
                }),
            )
            .await
            .unwrap_or_else(|_| "COMPLEXITY: simple\nPLANNING: direct_action\nCAPABILITIES:\nSTAKEHOLDERS:\nCONSTRAINTS:\nDEPENDENCIES:\nCONFIDENCE: 0.5".to_string());

        let lines: Vec<&str> = response.lines().collect();
        fn field<'a>(lines: &[&'a str], prefix: &str) -> &'a str {
            lines
                .iter()
                .find_map(|l| l.strip_prefix(prefix).map(|x| x.trim()))
                .unwrap_or("")
        }
        fn list_field(lines: &[&str], prefix: &str) -> Vec<Value> {
            let raw = field(lines, prefix);
            if raw.is_empty() {
                return vec![];
            }
            raw.split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| Value::String(s.to_string()))
                .collect()
        }

        let complexity = field(&lines, "COMPLEXITY:");
        let planning_type = field(&lines, "PLANNING:");
        let confidence_raw = field(&lines, "CONFIDENCE:");
        let confidence = confidence_raw.parse::<f64>().unwrap_or(0.5).clamp(0.0, 1.0);

        let planning_required = planning_type != "direct_action" && complexity != "simple";

        let mut classification = "general".to_string();
        let lower = text.to_lowercase();
        if lower.contains("strategic") || planning_type == "strategic_planning" {
            classification = "strategic".to_string();
        } else if lower.contains("analyz") {
            classification = "analysis".to_string();
        } else if lower.contains("process") {
            classification = "processing".to_string();
        } else if lower.contains("execute") {
            classification = "execution".to_string();
        }

        let mut data = HashMap::new();
        data.insert(
            "classification".to_string(),
            Value::String(classification.clone()),
        );
        data.insert(
            "confidence".to_string(),
            Value::Number(serde_json::Number::from_f64(confidence).unwrap()),
        );
        data.insert("originalText".to_string(), Value::String(text));
        data.insert(
            "complexity".to_string(),
            Value::String(if complexity.is_empty() {
                "simple".to_string()
            } else {
                complexity.to_string()
            }),
        );
        data.insert(
            "planningType".to_string(),
            Value::String(if planning_type.is_empty() {
                "direct_action".to_string()
            } else {
                planning_type.to_string()
            }),
        );
        data.insert(
            "planningRequired".to_string(),
            Value::Bool(planning_required),
        );
        data.insert(
            "capabilities".to_string(),
            Value::Array(list_field(&lines, "CAPABILITIES:")),
        );
        data.insert(
            "stakeholders".to_string(),
            Value::Array(list_field(&lines, "STAKEHOLDERS:")),
        );
        data.insert(
            "constraints".to_string(),
            Value::Array(list_field(&lines, "CONSTRAINTS:")),
        );
        data.insert(
            "dependencies".to_string(),
            Value::Array(list_field(&lines, "DEPENDENCIES:")),
        );

        Ok(ProviderResult {
            text: Some(format!(
                "Message classified as: {} ({} complexity, {}) with confidence: {}",
                classification,
                if complexity.is_empty() {
                    "simple"
                } else {
                    complexity
                },
                if planning_type.is_empty() {
                    "direct_action"
                } else {
                    planning_type
                },
                confidence
            )),
            values: None,
            data: Some(data),
        })
    }
}

struct AnalyzeInputAction;
struct ProcessAnalysisAction;
struct ExecuteFinalAction;
struct CreatePlanAction;

impl AnalyzeInputAction {
    fn definition_static() -> ActionDefinition {
        ActionDefinition {
            name: "ANALYZE_INPUT".to_string(),
            description: "Analyzes user input and extracts key information".to_string(),
            similes: None,
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }
}

#[async_trait::async_trait]
impl ActionHandler for AnalyzeInputAction {
    fn definition(&self) -> ActionDefinition {
        Self::definition_static()
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let text = message.content.text.clone().unwrap_or_default();
        let words: Vec<&str> = text.split_whitespace().collect();
        let has_numbers = text.chars().any(|c| c.is_ascii_digit());
        let lower = text.to_lowercase();
        let sentiment = if lower.contains("urgent")
            || lower.contains("emergency")
            || lower.contains("critical")
        {
            "urgent"
        } else if lower.contains("good") {
            "positive"
        } else if lower.contains("bad") {
            "negative"
        } else {
            "neutral"
        };

        let mut data = HashMap::new();
        data.insert(
            "wordCount".to_string(),
            Value::Number(serde_json::Number::from(words.len() as u64)),
        );
        data.insert("hasNumbers".to_string(), Value::Bool(has_numbers));
        data.insert(
            "sentiment".to_string(),
            Value::String(sentiment.to_string()),
        );
        data.insert(
            "timestamp".to_string(),
            Value::Number(serde_json::Number::from(0)),
        );

        Ok(Some(ActionResult {
            success: true,
            text: Some(format!(
                "Analyzed {} words with {} sentiment",
                words.len(),
                sentiment
            )),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}

impl ProcessAnalysisAction {
    fn definition_static() -> ActionDefinition {
        ActionDefinition {
            name: "PROCESS_ANALYSIS".to_string(),
            description: "Processes analysis results and makes decisions".to_string(),
            similes: None,
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }
}

#[async_trait::async_trait]
impl ActionHandler for ProcessAnalysisAction {
    fn definition(&self) -> ActionDefinition {
        Self::definition_static()
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let previous = options
            .and_then(|o| o.action_context.as_ref())
            .and_then(|c| c.previous_results.first())
            .and_then(|r| r.data.as_ref())
            .cloned()
            .unwrap_or_default();

        let word_count = previous
            .get("wordCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let sentiment = previous
            .get("sentiment")
            .and_then(|v| v.as_str())
            .unwrap_or("neutral");

        let needs_more_info = word_count < 5;
        let suggested = if sentiment == "positive" {
            "Thank you for the positive feedback!"
        } else if sentiment == "negative" {
            "I understand your concerns and will help address them."
        } else {
            "I can help you with that."
        };

        let mut data = HashMap::new();
        data.insert("needsMoreInfo".to_string(), Value::Bool(needs_more_info));
        data.insert(
            "suggestedResponse".to_string(),
            Value::String(suggested.to_string()),
        );
        data.insert("continueChain".to_string(), Value::Bool(!needs_more_info));

        Ok(Some(ActionResult {
            success: true,
            text: Some(suggested.to_string()),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}

impl ExecuteFinalAction {
    fn definition_static() -> ActionDefinition {
        ActionDefinition {
            name: "EXECUTE_FINAL".to_string(),
            description: "Executes the final action based on processing results".to_string(),
            similes: None,
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }
}

#[async_trait::async_trait]
impl ActionHandler for ExecuteFinalAction {
    fn definition(&self) -> ActionDefinition {
        Self::definition_static()
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        Ok(Some(ActionResult::success_with_text(
            "Executed final step successfully",
        )))
    }
}

impl CreatePlanAction {
    fn definition_static() -> ActionDefinition {
        ActionDefinition {
            name: "CREATE_PLAN".to_string(),
            description: "Creates a comprehensive project plan".to_string(),
            similes: Some(vec![
                "PLAN_PROJECT".to_string(),
                "GENERATE_PLAN".to_string(),
                "MAKE_PLAN".to_string(),
                "PROJECT_PLAN".to_string(),
            ]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }
}

#[async_trait::async_trait]
impl ActionHandler for CreatePlanAction {
    fn definition(&self) -> ActionDefinition {
        Self::definition_static()
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let t = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        t.contains("plan")
            || t.contains("project")
            || t.contains("comprehensive")
            || t.contains("organize")
            || t.contains("strategy")
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&crate::types::components::HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let mut data = HashMap::new();
        data.insert(
            "actionName".to_string(),
            Value::String("CREATE_PLAN".to_string()),
        );
        data.insert(
            "phaseCount".to_string(),
            Value::Number(serde_json::Number::from(1)),
        );
        Ok(Some(ActionResult {
            success: true,
            text: Some("Created 1-phase plan".to_string()),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}

/// Execution strategy for a plan.
#[derive(Clone, Debug)]
pub enum ExecutionModel {
    /// Run steps in a single linear sequence.
    Sequential,
    /// Run steps concurrently (best-effort).
    Parallel,
    /// Run steps respecting dependencies (DAG scheduling).
    Dag,
}

impl ExecutionModel {
    fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "parallel" => ExecutionModel::Parallel,
            "dag" => ExecutionModel::Dag,
            _ => ExecutionModel::Sequential,
        }
    }
}

/// Retry policy applied when a step fails.
#[derive(Clone, Debug)]
pub struct RetryPolicy {
    /// Maximum number of retries.
    pub max_retries: i32,
    /// Initial backoff delay (ms).
    pub backoff_ms: i64,
    /// Backoff multiplier applied per retry.
    pub backoff_multiplier: i64,
    /// Error behavior: "abort" | "continue" | "skip" (best-effort parity).
    pub on_error: String,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_retries: 2,
            backoff_ms: 1000,
            backoff_multiplier: 2,
            on_error: "abort".to_string(),
        }
    }
}

/// A single executable step within a plan.
#[derive(Clone, Debug)]
pub struct ActionStep {
    /// Step identifier.
    pub id: UUID,
    /// Action name to execute.
    pub action_name: String,
    /// Action parameters (JSON).
    pub parameters: HashMap<String, Value>,
    /// Step dependencies by id (for DAG execution).
    pub dependencies: Vec<UUID>,
    /// Retry policy for this step.
    pub retry_policy: RetryPolicy,
}

/// A multi-step plan to achieve a goal.
#[derive(Clone, Debug)]
pub struct ActionPlan {
    /// Plan identifier.
    pub id: UUID,
    /// High-level goal.
    pub goal: String,
    /// Ordered list of steps.
    pub steps: Vec<ActionStep>,
    /// Execution model for running steps.
    pub execution_model: ExecutionModel,
}

/// Result of executing a plan.
#[derive(Clone, Debug)]
pub struct PlanExecutionResult {
    /// Plan identifier.
    pub plan_id: UUID,
    /// Whether execution succeeded.
    pub success: bool,
    /// Number of action results produced.
    pub completed_steps: usize,
    /// Total number of steps in the plan.
    pub total_steps: usize,
    /// Action results from execution.
    pub results: Vec<ActionResult>,
}

#[derive(Default)]
struct ExecutionState {
    aborted: bool,
}

/// Advanced planning service registered under the name `"planning"`.
#[derive(Default)]
pub struct PlanningService {
    active_plans: Mutex<HashMap<UUID, ActionPlan>>,
    executions: Mutex<HashMap<UUID, ExecutionState>>,
}

impl PlanningService {
    /// Create a best-effort single/multi-step plan using heuristics.
    pub fn create_simple_plan(&self, message: &Memory) -> ActionPlan {
        let text = message.content.text.as_deref().unwrap_or("").to_lowercase();
        let actions: Vec<&str> = if text.contains("email") {
            vec!["SEND_EMAIL"]
        } else if text.contains("research") && (text.contains("send") || text.contains("summary")) {
            vec!["SEARCH", "REPLY"]
        } else if text.contains("search") || text.contains("find") || text.contains("research") {
            vec!["SEARCH"]
        } else if text.contains("analyz") {
            vec!["THINK", "REPLY"]
        } else {
            vec!["REPLY"]
        };

        let mut steps: Vec<ActionStep> = Vec::new();
        let mut prev: Option<UUID> = None;
        for a in actions {
            let id = UUID::new_v4();
            let deps = prev.clone().into_iter().collect::<Vec<_>>();
            let mut params = HashMap::new();
            params.insert(
                "message".to_string(),
                Value::String(message.content.text.clone().unwrap_or_default()),
            );
            steps.push(ActionStep {
                id: id.clone(),
                action_name: a.to_string(),
                parameters: params,
                dependencies: deps,
                retry_policy: RetryPolicy::default(),
            });
            prev = Some(id);
        }

        let plan = ActionPlan {
            id: UUID::new_v4(),
            goal: message
                .content
                .text
                .clone()
                .unwrap_or_else(|| "Execute plan".to_string()),
            steps,
            execution_model: ExecutionModel::Sequential,
        };

        self.active_plans
            .lock()
            .expect("lock poisoned")
            .insert(plan.id.clone(), plan.clone());

        plan
    }

    /// Create a plan using the configured LLM (`TEXT_LARGE`).
    pub async fn create_comprehensive_plan(
        &self,
        runtime: &AgentRuntime,
        context: &HashMap<String, Value>,
    ) -> Result<ActionPlan> {
        let goal = context
            .get("goal")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if goal.trim().is_empty() {
            anyhow::bail!("Planning context must have a non-empty goal");
        }

        let available_actions = context
            .get("availableActions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();

        let prompt = format!(
            "You are an expert AI planning system. Create a comprehensive action plan.\n\nGOAL: {}\n\nAVAILABLE ACTIONS: {}\n\nReturn XML with <plan><goal>..</goal><execution_model>..</execution_model><steps><step><id>..</id><action>..</action><parameters>{{}}</parameters><dependencies>[]</dependencies></step></steps></plan>",
            goal, available_actions
        );

        let params = serde_json::json!({
            "prompt": prompt,
            "temperature": 0.3,
            "maxTokens": 2000
        });

        let response = runtime.use_model(model_type::TEXT_LARGE, params).await?;
        let plan = parse_plan_from_xml(&response, &goal);

        self.active_plans
            .lock()
            .expect("lock poisoned")
            .insert(plan.id.clone(), plan.clone());

        Ok(plan)
    }

    fn dag_execution_order(steps: &[ActionStep]) -> Result<Vec<usize>> {
        let mut deps_remaining: HashMap<UUID, usize> = HashMap::new();
        let mut dependents: HashMap<UUID, Vec<UUID>> = HashMap::new();
        let mut index_by_id: HashMap<UUID, usize> = HashMap::new();
        for (idx, step) in steps.iter().enumerate() {
            deps_remaining.insert(step.id.clone(), step.dependencies.len());
            index_by_id.insert(step.id.clone(), idx);
            for dep in &step.dependencies {
                dependents
                    .entry(dep.clone())
                    .or_default()
                    .push(step.id.clone());
            }
        }

        let mut ready: BinaryHeap<Reverse<usize>> = BinaryHeap::new();
        for (idx, step) in steps.iter().enumerate() {
            if step.dependencies.is_empty() {
                ready.push(Reverse(idx));
            }
        }

        let mut order: Vec<usize> = Vec::with_capacity(steps.len());
        while let Some(Reverse(idx)) = ready.pop() {
            order.push(idx);
            let step_id = steps[idx].id.clone();
            if let Some(next_steps) = dependents.get(&step_id) {
                for next_id in next_steps {
                    if let Some(remaining) = deps_remaining.get_mut(next_id) {
                        if *remaining > 0 {
                            *remaining -= 1;
                            if *remaining == 0 {
                                if let Some(next_idx) = index_by_id.get(next_id) {
                                    ready.push(Reverse(*next_idx));
                                }
                            }
                        }
                    }
                }
            }
        }

        if order.len() != steps.len() {
            anyhow::bail!("No steps ready to execute - possible circular dependency");
        }

        Ok(order)
    }

    /// Validate a plan against runtime actions and dependency integrity.
    pub async fn validate_plan(
        &self,
        runtime: &AgentRuntime,
        plan: &ActionPlan,
    ) -> (bool, Vec<String>) {
        let mut issues: Vec<String> = Vec::new();
        if plan.steps.is_empty() {
            issues.push("Plan has no steps".to_string());
        }

        let defs = runtime.list_action_definitions().await;
        let mut known: HashSet<String> = HashSet::new();
        for d in &defs {
            known.insert(d.name.to_lowercase());
            if let Some(similes) = &d.similes {
                for s in similes {
                    known.insert(s.to_lowercase());
                }
            }
        }

        let ids: HashSet<UUID> = plan.steps.iter().map(|s| s.id.clone()).collect();
        for step in &plan.steps {
            let name = step.action_name.to_lowercase();
            if !known.contains(&name) && name != "reply" {
                issues.push(format!(
                    "Action '{}' not found in runtime",
                    step.action_name
                ));
            }
            for dep in &step.dependencies {
                if !ids.contains(dep) {
                    issues.push(format!(
                        "Step '{}' has invalid dependency '{}'",
                        step.id, dep
                    ));
                }
            }
        }
        (issues.is_empty(), issues)
    }

    /// Execute a plan by invoking `runtime.process_selected_actions` per step.
    pub async fn execute_plan(
        &self,
        runtime: &AgentRuntime,
        plan: &ActionPlan,
        message: &Memory,
        state: &State,
    ) -> Result<PlanExecutionResult> {
        self.executions
            .lock()
            .expect("lock poisoned")
            .insert(plan.id.clone(), ExecutionState { aborted: false });

        let mut results: Vec<ActionResult> = Vec::new();

        match plan.execution_model {
            ExecutionModel::Sequential => {
                for step in &plan.steps {
                    self.check_abort(&plan.id)?;
                    let step_results = self.execute_step(runtime, step, message, state).await?;
                    results.extend(step_results);
                }
            }
            ExecutionModel::Parallel => {
                let futs = plan.steps.iter().map(|step| async move {
                    self.execute_step(runtime, step, message, state).await
                });
                let out = futures::future::join_all(futs).await;
                for r in out {
                    self.check_abort(&plan.id)?;
                    results.extend(r?);
                }
            }
            ExecutionModel::Dag => {
                let order = Self::dag_execution_order(&plan.steps)?;
                for idx in order {
                    self.check_abort(&plan.id)?;
                    let step = &plan.steps[idx];
                    let step_results = self.execute_step(runtime, step, message, state).await?;
                    results.extend(step_results);
                }
            }
        }

        self.executions
            .lock()
            .expect("lock poisoned")
            .remove(&plan.id);

        Ok(PlanExecutionResult {
            plan_id: plan.id.clone(),
            success: true,
            completed_steps: results.len(),
            total_steps: plan.steps.len(),
            results,
        })
    }

    async fn execute_step(
        &self,
        runtime: &AgentRuntime,
        step: &ActionStep,
        message: &Memory,
        state: &State,
    ) -> Result<Vec<ActionResult>> {
        let mut params = HashMap::new();
        params.insert(step.action_name.to_uppercase(), step.parameters.clone());
        runtime
            .process_selected_actions(
                message,
                state,
                std::slice::from_ref(&step.action_name),
                &params,
            )
            .await
    }

    fn check_abort(&self, plan_id: &UUID) -> Result<()> {
        let guard = self.executions.lock().expect("lock poisoned");
        if let Some(s) = guard.get(plan_id) {
            if s.aborted {
                anyhow::bail!("Plan execution aborted");
            }
        }
        Ok(())
    }

    /// Cancel a currently executing plan (best-effort).
    pub fn cancel_plan(&self, plan_id: &UUID) -> bool {
        let mut guard = self.executions.lock().expect("lock poisoned");
        if let Some(s) = guard.get_mut(plan_id) {
            s.aborted = true;
            return true;
        }
        false
    }
}

#[async_trait::async_trait]
impl Service for PlanningService {
    fn service_type(&self) -> &str {
        "planning"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> Result<()> {
        Ok(())
    }
}

fn parse_plan_from_xml(xml: &str, fallback_goal: &str) -> ActionPlan {
    let parsed = parse_key_value_xml(xml).unwrap_or_default();
    let goal = parsed
        .get("goal")
        .cloned()
        .unwrap_or_else(|| fallback_goal.to_string());
    let execution_model = parsed
        .get("execution_model")
        .map(|s| ExecutionModel::from_str(s))
        .unwrap_or(ExecutionModel::Sequential);

    let step_re = Regex::new(r"(?s)<step>(.*?)</step>").expect("regex");
    let id_re = Regex::new(r"(?s)<id>(.*?)</id>").expect("regex");
    let action_re = Regex::new(r"(?s)<action>(.*?)</action>").expect("regex");
    let params_re = Regex::new(r"(?s)<parameters>(.*?)</parameters>").expect("regex");
    let deps_re = Regex::new(r"(?s)<dependencies>(.*?)</dependencies>").expect("regex");

    let mut steps: Vec<ActionStep> = Vec::new();
    let mut id_map: HashMap<String, UUID> = HashMap::new();
    let mut dep_strings: HashMap<UUID, Vec<String>> = HashMap::new();

    for cap in step_re.captures_iter(xml) {
        let block = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let orig_id = id_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());
        let action = action_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());
        if orig_id.is_none() || action.is_none() {
            continue;
        }
        let orig_id = orig_id.unwrap();
        let action = action.unwrap();
        let actual_id = UUID::new_v4();
        id_map.insert(orig_id.clone(), actual_id.clone());

        let params: HashMap<String, Value> = params_re
            .captures(block)
            .and_then(|c| c.get(1))
            .and_then(|m| serde_json::from_str::<HashMap<String, Value>>(m.as_str().trim()).ok())
            .unwrap_or_default();

        let deps: Vec<String> = deps_re
            .captures(block)
            .and_then(|c| c.get(1))
            .and_then(|m| serde_json::from_str::<Vec<String>>(m.as_str().trim()).ok())
            .unwrap_or_default();

        dep_strings.insert(actual_id.clone(), deps);

        steps.push(ActionStep {
            id: actual_id,
            action_name: action,
            parameters: params,
            dependencies: Vec::new(),
            retry_policy: RetryPolicy::default(),
        });
    }

    for step in steps.iter_mut() {
        let deps = dep_strings.get(&step.id).cloned().unwrap_or_default();
        let mut resolved: Vec<UUID> = Vec::new();
        for d in deps {
            if let Some(id) = id_map.get(&d) {
                resolved.push(id.clone());
            }
        }
        step.dependencies = resolved;
    }

    if steps.is_empty() {
        let mut params = HashMap::new();
        params.insert(
            "text".to_string(),
            Value::String("I will help you with this request step by step.".to_string()),
        );
        steps.push(ActionStep {
            id: UUID::new_v4(),
            action_name: "REPLY".to_string(),
            parameters: params,
            dependencies: Vec::new(),
            retry_policy: RetryPolicy::default(),
        });
    }

    ActionPlan {
        id: UUID::new_v4(),
        goal,
        steps,
        execution_model,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{AgentRuntime, RuntimeOptions};
    use crate::types::agent::{Bio, Character};
    use crate::types::components::{ActionDefinition, ActionHandler, HandlerOptions};
    use crate::types::plugin::Plugin;
    use anyhow::Result;
    use std::sync::Arc;

    struct ReplyAction;

    #[async_trait::async_trait]
    impl ActionHandler for ReplyAction {
        fn definition(&self) -> ActionDefinition {
            ActionDefinition {
                name: "REPLY".to_string(),
                description: "Reply with text".to_string(),
                similes: Some(vec!["RESPOND".to_string()]),
                examples: None,
                priority: None,
                tags: None,
                parameters: None,
            }
        }

        async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
            true
        }

        async fn handle(
            &self,
            _message: &Memory,
            _state: Option<&State>,
            _options: Option<&HandlerOptions>,
        ) -> Result<Option<ActionResult>> {
            Ok(Some(ActionResult::success_with_text("ok")))
        }
    }

    #[tokio::test]
    async fn creates_comprehensive_plan_and_executes() -> Result<()> {
        let character = Character {
            name: "AdvPlanningRust".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_planning: Some(true),
            ..Default::default()
        };

        let plugin = Plugin::new("test-reply", "test").with_action(Arc::new(ReplyAction));

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            plugins: vec![plugin],
            ..Default::default()
        })
        .await?;

        runtime
            .register_model(
                model_type::TEXT_LARGE,
                Box::new(|_params| {
                    Box::pin(async move {
                        Ok([
                            "<plan>",
                            "<goal>Do thing</goal>",
                            "<execution_model>sequential</execution_model>",
                            "<steps>",
                            "<step>",
                            "<id>step_1</id>",
                            "<action>REPLY</action>",
                            "<parameters>{\"text\":\"ok\"}</parameters>",
                            "<dependencies>[]</dependencies>",
                            "</step>",
                            "</steps>",
                            "</plan>",
                        ]
                        .join("\n"))
                    })
                }),
            )
            .await;

        runtime.initialize().await?;

        let svc = runtime
            .get_service("planning")
            .await
            .expect("planning service");
        let planning = svc
            .as_any()
            .downcast_ref::<PlanningService>()
            .expect("PlanningService downcast");

        let mut ctx: HashMap<String, Value> = HashMap::new();
        ctx.insert("goal".to_string(), Value::String("Do thing".to_string()));
        ctx.insert(
            "availableActions".to_string(),
            Value::Array(vec![Value::String("REPLY".to_string())]),
        );

        let plan = planning.create_comprehensive_plan(&runtime, &ctx).await?;
        assert_eq!(plan.steps.len(), 1);

        let message = Memory::message(UUID::new_v4(), UUID::new_v4(), "hi");
        let state = runtime.compose_state(&message).await?;
        let exec = planning
            .execute_plan(&runtime, &plan, &message, &state)
            .await?;

        assert!(exec.success);
        assert_eq!(exec.total_steps, 1);
        assert!(exec.completed_steps >= 1);
        Ok(())
    }

    #[test]
    fn dag_execution_order_respects_dependencies() -> Result<()> {
        let step_a = ActionStep {
            id: UUID::new_v4(),
            action_name: "A".to_string(),
            parameters: HashMap::new(),
            dependencies: Vec::new(),
            retry_policy: RetryPolicy::default(),
        };
        let step_b = ActionStep {
            id: UUID::new_v4(),
            action_name: "B".to_string(),
            parameters: HashMap::new(),
            dependencies: Vec::new(),
            retry_policy: RetryPolicy::default(),
        };
        let step_c = ActionStep {
            id: UUID::new_v4(),
            action_name: "C".to_string(),
            parameters: HashMap::new(),
            dependencies: vec![step_b.id.clone()],
            retry_policy: RetryPolicy::default(),
        };
        let steps = vec![step_a, step_b, step_c];

        let order = PlanningService::dag_execution_order(&steps)?;
        assert_eq!(order, vec![0, 1, 2]);

        Ok(())
    }

    #[test]
    fn dag_execution_order_detects_cycles() {
        let step_a_id = UUID::new_v4();
        let step_b_id = UUID::new_v4();
        let steps = vec![
            ActionStep {
                id: step_a_id.clone(),
                action_name: "A".to_string(),
                parameters: HashMap::new(),
                dependencies: vec![step_b_id.clone()],
                retry_policy: RetryPolicy::default(),
            },
            ActionStep {
                id: step_b_id.clone(),
                action_name: "B".to_string(),
                parameters: HashMap::new(),
                dependencies: vec![step_a_id.clone()],
                retry_policy: RetryPolicy::default(),
            },
        ];

        let result = PlanningService::dag_execution_order(&steps);
        assert!(result.is_err());
    }
}
