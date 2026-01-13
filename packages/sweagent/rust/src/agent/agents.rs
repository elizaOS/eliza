//! Core agent implementations for SWE-agent
//!
//! This module contains the main agent types that coordinate the problem-solving loop.

use super::history_processors::{
    create_history_processor, ChainedHistoryProcessor, HistoryProcessor, HistoryProcessorConfig,
};
use super::hooks::{AgentHook, CombinedAgentHook, QueryMessageEvent};
use super::models::{get_model, GlobalStats, InstanceStats, Model, ModelConfig};
use super::problem_statement::{
    create_problem_statement, ProblemStatement, ProblemStatementConfig,
};
use super::reviewer::{get_retry_loop_from_config, RetryLoop, RetryLoopConfig, ReviewSubmission};
use crate::environment::SWEEnv;
use crate::exceptions::{tokens, Result, SWEAgentError};
use crate::tools::{ToolConfig, ToolHandler};
use crate::types::{
    AgentInfo, AgentRunResult, Content, EnvironmentState, History, HistoryItem, MessageType,
    QueryMessage, Role, StepOutput, TemplateConfig, Trajectory, TrajectoryStep,
};
use crate::utils::template::render_template;
use crate::VERSION;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Trait for all agent types
#[async_trait]
pub trait Agent: Send + Sync {
    /// Add a hook to the agent
    fn add_hook(&mut self, hook: Box<dyn AgentHook>);

    /// Get trajectory data
    fn get_trajectory_data(&self) -> TrajectoryData;

    /// Run a single step
    async fn step(&mut self) -> Result<StepOutput>;

    /// Run the agent on a problem
    async fn run(
        &mut self,
        env: &mut SWEEnv,
        problem_statement: Box<dyn ProblemStatement>,
        output_dir: &Path,
    ) -> Result<AgentRunResult>;
}

/// Data from a trajectory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrajectoryData {
    pub trajectory: Trajectory,
    pub history: History,
    pub info: AgentInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_config: Option<String>,
    pub environment: String,
}

/// Configuration for the default agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultAgentConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub templates: TemplateConfig,
    #[serde(default)]
    pub tools: ToolConfig,
    #[serde(default)]
    pub history_processors: Vec<HistoryProcessorConfig>,
    #[serde(default)]
    pub model: ModelConfig,
    #[serde(default = "default_max_requeries")]
    pub max_requeries: usize,
}

fn default_max_requeries() -> usize {
    3
}

impl Default for DefaultAgentConfig {
    fn default() -> Self {
        Self {
            name: "main".to_string(),
            templates: TemplateConfig::default(),
            tools: ToolConfig::default(),
            history_processors: Vec::new(),
            model: ModelConfig::default(),
            max_requeries: default_max_requeries(),
        }
    }
}

/// Default agent implementation
pub struct DefaultAgent {
    pub name: String,
    model: Box<dyn Model>,
    templates: TemplateConfig,
    tools: ToolHandler,
    history_processors: Box<dyn HistoryProcessor>,
    max_requeries: usize,

    // Runtime state
    env: Option<Arc<tokio::sync::Mutex<SWEEnv>>>,
    problem_statement: Option<Box<dyn ProblemStatement>>,
    traj_path: Option<PathBuf>,
    history: History,
    trajectory: Trajectory,
    info: AgentInfo,
    chook: CombinedAgentHook,

    // Counters
    n_consecutive_timeouts: usize,
    total_execution_time: f64,
}

impl DefaultAgent {
    pub fn new(
        name: impl Into<String>,
        model: Box<dyn Model>,
        templates: TemplateConfig,
        tools: ToolHandler,
        history_processors: Box<dyn HistoryProcessor>,
        max_requeries: usize,
    ) -> Self {
        Self {
            name: name.into(),
            model,
            templates,
            tools,
            history_processors,
            max_requeries,
            env: None,
            problem_statement: None,
            traj_path: None,
            history: Vec::new(),
            trajectory: Vec::new(),
            info: AgentInfo::default(),
            chook: CombinedAgentHook::new(),
            n_consecutive_timeouts: 0,
            total_execution_time: 0.0,
        }
    }

    pub fn from_config(config: DefaultAgentConfig) -> Result<Self> {
        let global_stats = Arc::new(GlobalStats::default());
        let model = get_model(config.model, global_stats)?;
        let tools = ToolHandler::new(config.tools)?;

        let processors: Vec<Box<dyn HistoryProcessor>> = config
            .history_processors
            .iter()
            .map(create_history_processor)
            .collect();

        let history_processor: Box<dyn HistoryProcessor> = if processors.is_empty() {
            Box::new(super::history_processors::DefaultHistoryProcessor)
        } else {
            Box::new(ChainedHistoryProcessor::new(processors))
        };

        Ok(Self::new(
            config.name,
            model,
            config.templates,
            tools,
            history_processor,
            config.max_requeries,
        ))
    }

    /// Get processed messages for model query
    fn get_messages(&self) -> History {
        let filtered: History = self
            .history
            .iter()
            .filter(|item| item.agent.as_deref() == Some(&self.name) || item.agent.is_none())
            .cloned()
            .collect();

        self.history_processors.process(filtered)
    }

    fn append_history(&mut self, item: HistoryItem) {
        let event = QueryMessageEvent {
            agent: item.agent.clone().unwrap_or_default(),
            role: format!("{:?}", item.role),
            content: item.content.as_str(),
            message_type: item
                .message_type
                .as_ref()
                .map(|t| format!("{:?}", t))
                .unwrap_or_default(),
            is_demo: item.is_demo,
            thought: item.thought.clone(),
            action: item.action.clone(),
        };
        self.chook.on_query_message_added(&event);
        self.history.push(item);
    }

    /// Setup the agent for a new problem instance
    pub async fn setup(
        &mut self,
        env: Arc<tokio::sync::Mutex<SWEEnv>>,
        problem_statement: Box<dyn ProblemStatement>,
        output_dir: &Path,
    ) -> Result<()> {
        std::fs::create_dir_all(output_dir)?;

        self.problem_statement = Some(problem_statement);
        self.env = Some(env.clone());

        let ps = self.problem_statement.as_ref().unwrap();
        let iid = ps.id();
        tracing::info!(instance_id = iid, "Setting up agent");

        self.traj_path = Some(output_dir.join(format!("{}.traj", iid)));
        tracing::info!(path = ?self.traj_path, "Trajectory will be saved");

        self.chook.on_tools_installation_started();

        {
            let mut env_guard = env.lock().await;
            self.tools.install(&mut env_guard).await?;
        }

        self.chook.on_setup_attempt();

        self.info = AgentInfo {
            swe_agent_version: Some(VERSION.to_string()),
            ..Default::default()
        };

        // Add system message
        self.add_system_message_to_history();

        // Add demonstrations
        self.add_demonstrations_to_history()?;

        // Add instance template
        let state = {
            let env_guard = env.lock().await;
            self.tools.get_state(&env_guard).await
        };
        self.add_instance_template_to_history(&state);

        self.chook.on_setup_done();

        Ok(())
    }

    fn get_format_dict(&self, extra: Option<HashMap<String, String>>) -> HashMap<String, String> {
        let mut dict = extra.unwrap_or_default();

        if let Some(ref ps) = self.problem_statement {
            dict.insert("problem_statement".to_string(), ps.get_problem_statement());
            for (k, v) in ps.get_extra_fields() {
                dict.insert(k, v);
            }
        }

        if let Some(ref cmd_docs) = self.tools.config.command_docs {
            dict.insert("command_docs".to_string(), cmd_docs.clone());
        }

        dict
    }

    fn add_system_message_to_history(&mut self) {
        let format_dict = self.get_format_dict(None);
        let system_msg = render_template(&self.templates.system_template, &format_dict)
            .unwrap_or_else(|_| self.templates.system_template.clone());

        tracing::info!(agent = %self.name, "SYSTEM\n{}", system_msg);

        self.append_history(HistoryItem {
            role: Role::System,
            content: Content::Text(system_msg),
            agent: Some(self.name.clone()),
            message_type: Some(MessageType::System),
            ..Default::default()
        });
    }

    fn add_demonstrations_to_history(&mut self) -> Result<()> {
        for demo_path in &self.templates.demonstrations.clone() {
            self.add_demonstration_to_history(demo_path)?;
        }
        Ok(())
    }

    fn add_demonstration_to_history(&mut self, demo_path: &str) -> Result<()> {
        if self.templates.demonstration_template.is_none() && !self.templates.put_demos_in_history {
            return Err(SWEAgentError::ConfigurationError(
                "Cannot use demonstrations without demonstration_template or put_demos_in_history"
                    .to_string(),
            ));
        }

        tracing::info!(path = demo_path, "Loading demonstration");
        let content = std::fs::read_to_string(demo_path)?;

        // Parse demonstration (YAML or JSON)
        let demo_history: Vec<HistoryItem> =
            if demo_path.ends_with(".yaml") || demo_path.ends_with(".yml") {
                let parsed: serde_yaml::Value = serde_yaml::from_str(&content)?;
                if let Some(history) = parsed.get("history") {
                    serde_yaml::from_value(history.clone())?
                } else {
                    Vec::new()
                }
            } else {
                let parsed: serde_json::Value = serde_json::from_str(&content)?;
                if let Some(history) = parsed.get("history") {
                    serde_json::from_value(history.clone())?
                } else {
                    Vec::new()
                }
            };

        if self.templates.put_demos_in_history {
            for mut entry in demo_history {
                if entry.role != Role::System {
                    entry.is_demo = Some(true);
                    entry.agent = Some(entry.agent.unwrap_or_else(|| self.name.clone()));
                    self.append_history(entry);
                }
            }
        } else if let Some(ref template) = self.templates.demonstration_template {
            let demo_text: String = demo_history
                .iter()
                .filter(|e| e.role != Role::System)
                .map(|e| e.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");

            let mut vars = HashMap::new();
            vars.insert("demonstration".to_string(), demo_text);
            let demonstration = render_template(template, &vars)?;

            self.append_history(HistoryItem {
                role: Role::User,
                content: Content::Text(demonstration),
                agent: Some(self.name.clone()),
                is_demo: Some(true),
                message_type: Some(MessageType::Demonstration),
                ..Default::default()
            });
        }

        Ok(())
    }

    fn add_instance_template_to_history(&mut self, state: &HashMap<String, String>) {
        let format_dict = self.get_format_dict(Some(state.clone()));

        let mut templates = vec![self.templates.instance_template.clone()];
        if let Some(ref strategy) = self.templates.strategy_template {
            templates.push(strategy.clone());
        }

        let message: String = templates
            .iter()
            .filter_map(|t| render_template(t, &format_dict).ok())
            .collect::<Vec<_>>()
            .join("\n");

        self.append_history(HistoryItem {
            role: Role::User,
            content: Content::Text(message),
            agent: Some(self.name.clone()),
            message_type: Some(MessageType::Observation),
            ..Default::default()
        });
    }

    #[allow(dead_code)]
    fn get_trajectory(&self) -> Trajectory {
        self.trajectory.clone()
    }

    fn save_trajectory(&self) -> Result<()> {
        if let Some(ref path) = self.traj_path {
            let data = self.get_trajectory_data();
            let json = serde_json::to_string_pretty(&data)?;
            std::fs::write(path, json)?;
        }
        Ok(())
    }

    async fn forward(&mut self, history: History) -> Result<StepOutput> {
        if self.total_execution_time > self.tools.config.total_execution_timeout as f64 {
            return Err(SWEAgentError::TotalExecutionTimeExceeded);
        }

        let mut step = StepOutput {
            query: history
                .iter()
                .map(|h| QueryMessage {
                    role: h.role.clone(),
                    content: h.content.as_str(),
                    message_type: h.message_type.clone(),
                })
                .collect(),
            ..Default::default()
        };

        // Query model
        self.chook.on_model_query(&history, &self.name);

        let output = self.model.query(&history).await?;

        step.output = output.message.clone();

        // Parse thought and action
        let (thought, action) = self.tools.parse_actions(&output)?;
        step.thought = thought;
        step.action = action;
        step.thinking_blocks = output.thinking_blocks;
        step.tool_calls = output.tool_calls.clone();

        if let Some(ref tool_calls) = output.tool_calls {
            step.tool_call_ids = Some(tool_calls.iter().map(|tc| tc.id.clone()).collect());
        }

        tracing::info!(
            thought = %step.thought,
            action = %step.action,
            "💭 THOUGHT / 🎬 ACTION"
        );

        self.chook.on_actions_generated(&step);

        self.handle_action(&mut step).await
    }

    async fn handle_action(&mut self, step: &mut StepOutput) -> Result<StepOutput> {
        // Check if action is blocked
        if self.tools.should_block_action(&step.action) {
            return Err(SWEAgentError::BlockedAction(step.action.clone()));
        }

        // Handle exit command
        if step.action.trim() == "exit" {
            tracing::info!("Exiting agent");
            step.done = true;
            step.observation = "Exited".to_string();
            step.exit_status = Some("exit_command".to_string());

            if let Some(ref env) = self.env {
                let env_guard = env.lock().await;
                let state_map = self.tools.get_state(&env_guard).await;
                step.state = EnvironmentState {
                    working_dir: state_map.get("working_dir").cloned(),
                    open_files: state_map
                        .get("open_files")
                        .map(|s| s.split(", ").map(String::from).collect()),
                    git_status: state_map.get("git_status").cloned(),
                    ..Default::default()
                };
            }

            return Ok(step.clone());
        }

        self.chook.on_action_started(step);
        let execution_start = std::time::Instant::now();

        let run_action = self.tools.guard_multiline_input(&step.action);

        // Execute command
        let observation = if let Some(ref env) = self.env {
            let env_guard = env.lock().await;
            match env_guard
                .communicate(&run_action, Some(self.tools.config.execution_timeout))
                .await
            {
                Ok(output) => {
                    self.n_consecutive_timeouts = 0;
                    output
                }
                Err(SWEAgentError::CommandTimeout { timeout, command }) => {
                    self.n_consecutive_timeouts += 1;
                    if self.n_consecutive_timeouts
                        >= self.tools.config.max_consecutive_execution_timeouts
                    {
                        return Err(SWEAgentError::CommandTimeout { timeout, command });
                    }

                    env_guard.interrupt_session().await?;

                    let mut vars = HashMap::new();
                    vars.insert("timeout".to_string(), timeout.to_string());
                    vars.insert("command".to_string(), command);
                    render_template(&self.templates.command_cancelled_timeout_template, &vars)?
                }
                Err(e) => return Err(e),
            }
        } else {
            return Err(SWEAgentError::EnvironmentError(
                "Environment not initialized".to_string(),
            ));
        };

        step.observation = observation.clone();
        step.execution_time = execution_start.elapsed().as_secs_f64();
        self.total_execution_time += step.execution_time;

        self.chook.on_action_executed(step);

        if let Some(ref env) = self.env {
            let env_guard = env.lock().await;
            let state_map = self.tools.get_state(&env_guard).await;
            step.state = EnvironmentState {
                working_dir: state_map.get("working_dir").cloned(),
                open_files: state_map
                    .get("open_files")
                    .map(|s| s.split(", ").map(String::from).collect()),
                git_status: state_map.get("git_status").cloned(),
                ..Default::default()
            };
        }

        // Check for special tokens
        if observation.contains(tokens::RETRY_WITH_OUTPUT) {
            step.observation = observation.replace(tokens::RETRY_WITH_OUTPUT, "");
            return Err(SWEAgentError::RetryWithOutput);
        } else if observation.contains(tokens::RETRY_WITHOUT_OUTPUT) {
            step.observation = observation.replace(tokens::RETRY_WITHOUT_OUTPUT, "");
            return Err(SWEAgentError::RetryWithoutOutput);
        } else if observation.contains(tokens::EXIT_FORFEIT) {
            return Err(SWEAgentError::ExitForfeit);
        }

        self.handle_submission(step, None, false).await
    }

    async fn handle_submission(
        &self,
        step: &mut StepOutput,
        observation: Option<&str>,
        force_submission: bool,
    ) -> Result<StepOutput> {
        let obs = observation.unwrap_or(&step.observation);
        let is_submission = self.tools.check_for_submission_cmd(obs);

        if is_submission || force_submission {
            if let Some(ref env) = self.env {
                let env_guard = env.lock().await;
                match env_guard.read_file("/root/model.patch").await {
                    Ok(submission) => {
                        let trimmed = submission.trim();
                        if !trimmed.is_empty() {
                            step.submission = Some(submission.clone());
                            step.observation = submission;
                        }

                        if step.exit_status.is_none() {
                            step.exit_status = Some("submitted".to_string());
                        } else if step.submission.is_some() {
                            let status = step.exit_status.as_ref().unwrap();
                            step.exit_status = Some(format!("submitted ({})", status));
                        }

                        step.done = true;
                        tracing::info!(submission = ?step.submission, "Found submission");
                    }
                    Err(_) => {
                        tracing::warn!("Submission file not found");
                    }
                }
            }
        }

        Ok(step.clone())
    }

    fn add_step_to_trajectory(&mut self, step: &StepOutput) {
        self.trajectory.push(TrajectoryStep::from(step));
    }

    async fn forward_with_handling(&mut self, mut history: History) -> Result<StepOutput> {
        let mut n_format_fails = 0;

        loop {
            match self.forward(history.clone()).await {
                Ok(step) => return Ok(step),
                Err(e) => {
                    if e.should_exit() {
                        let mut step = StepOutput {
                            done: true,
                            thought: e.to_string(),
                            exit_status: Some(e.exit_status().to_string()),
                            ..Default::default()
                        };
                        return self.attempt_autosubmission_after_error(&mut step).await;
                    }

                    if e.should_retry() {
                        n_format_fails += 1;
                        if n_format_fails >= self.max_requeries {
                            let mut step = StepOutput {
                                done: true,
                                thought: "Exit due to repeated format errors".to_string(),
                                exit_status: Some("exit_format".to_string()),
                                ..Default::default()
                            };
                            return self.attempt_autosubmission_after_error(&mut step).await;
                        }

                        // Prepare requery
                        let template = &self.tools.config.format_error_template;
                        let vars = self.get_format_dict(None);
                        let error_msg = render_template(template, &vars)?;

                        history = self.get_messages();
                        history.push(HistoryItem {
                            role: Role::User,
                            content: Content::Text(error_msg),
                            agent: Some(self.name.clone()),
                            message_type: Some(MessageType::User),
                            ..Default::default()
                        });

                        continue;
                    }

                    return Err(e);
                }
            }
        }
    }

    async fn attempt_autosubmission_after_error(
        &self,
        step: &mut StepOutput,
    ) -> Result<StepOutput> {
        tracing::warn!("Attempting autosubmission after error");
        step.done = true;

        if let Some(ref env) = self.env {
            let env_guard = env.lock().await;

            // Try to create submission
            let submission_cmd = "git add -A && git diff --cached > /root/model.patch";
            let _ = env_guard.communicate(submission_cmd, Some(30)).await;
        }

        self.handle_submission(step, None, true).await
    }
}

#[async_trait]
impl Agent for DefaultAgent {
    fn add_hook(&mut self, hook: Box<dyn AgentHook>) {
        self.chook.add_hook(hook);
    }

    fn get_trajectory_data(&self) -> TrajectoryData {
        TrajectoryData {
            trajectory: self.trajectory.clone(),
            history: self.history.clone(),
            info: self.info.clone(),
            replay_config: None,
            environment: "unknown".to_string(),
        }
    }

    async fn step(&mut self) -> Result<StepOutput> {
        self.chook.on_step_start();

        let n_step = self.trajectory.len() + 1;
        tracing::info!(step = n_step, "Starting step");

        let messages = self.get_messages();
        let step_output = self.forward_with_handling(messages).await?;

        // Add to history
        self.append_history(HistoryItem {
            role: Role::Assistant,
            content: Content::Text(step_output.output.clone()),
            thought: Some(step_output.thought.clone()),
            action: Some(step_output.action.clone()),
            agent: Some(self.name.clone()),
            tool_calls: step_output.tool_calls.clone(),
            message_type: Some(MessageType::Action),
            thinking_blocks: step_output.thinking_blocks.clone(),
            ..Default::default()
        });

        // Add observation
        let observation = &step_output.observation;
        let template = if observation.trim().is_empty() {
            self.templates
                .next_step_no_output_template
                .as_ref()
                .unwrap_or(&self.templates.next_step_template)
        } else if observation.len() > self.templates.max_observation_length {
            &self.templates.next_step_truncated_observation_template
        } else {
            &self.templates.next_step_template
        };

        let mut format_dict = self.get_format_dict(None);
        format_dict.insert("observation".to_string(), observation.clone());
        format_dict.insert(
            "elided_chars".to_string(),
            (observation
                .len()
                .saturating_sub(self.templates.max_observation_length))
            .to_string(),
        );
        format_dict.insert(
            "max_observation_length".to_string(),
            self.templates.max_observation_length.to_string(),
        );

        let obs_message = render_template(template, &format_dict)?;

        self.append_history(HistoryItem {
            role: Role::User,
            content: Content::Text(obs_message),
            agent: Some(self.name.clone()),
            message_type: Some(MessageType::Observation),
            tool_call_ids: step_output.tool_call_ids.clone(),
            ..Default::default()
        });

        // Update info
        self.info.submission = step_output.submission.clone();
        self.info.exit_status = step_output.exit_status.clone();
        self.info.model_stats = Some(self.model.get_stats().to_model_stats());

        self.add_step_to_trajectory(&step_output);
        self.chook.on_step_done(&step_output, &self.info);

        Ok(step_output)
    }

    async fn run(
        &mut self,
        env: &mut SWEEnv,
        problem_statement: Box<dyn ProblemStatement>,
        output_dir: &Path,
    ) -> Result<AgentRunResult> {
        // Wrap env in Arc<Mutex> for shared access
        let env_arc = Arc::new(tokio::sync::Mutex::new(std::mem::take(env)));

        self.setup(env_arc.clone(), problem_statement, output_dir)
            .await?;

        self.chook.on_run_start();
        let mut step_output = StepOutput::default();

        while !step_output.done {
            step_output = self.step().await?;
            let _ = self.save_trajectory();
        }

        self.chook.on_run_done(&self.trajectory, &self.info);
        tracing::info!(path = ?self.traj_path, "Trajectory saved");

        // Restore env
        let restored_env = Arc::try_unwrap(env_arc)
            .map_err(|_| SWEAgentError::RuntimeError("Could not restore environment".to_string()))?
            .into_inner();
        *env = restored_env;

        Ok(AgentRunResult {
            info: self.info.clone(),
            trajectory: self.trajectory.clone(),
        })
    }
}

/// Configuration for retry agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryAgentConfig {
    #[serde(default)]
    pub name: String,
    pub agent_configs: Vec<DefaultAgentConfig>,
    #[serde(default)]
    pub retry_loop: RetryLoopConfig,
}

/// Retry agent that tries multiple configurations
pub struct RetryAgent {
    config: RetryAgentConfig,
    hooks: Vec<Box<dyn AgentHook>>,
    i_attempt: usize,
    agent: Option<DefaultAgent>,
    attempt_data: Vec<TrajectoryData>,
    total_instance_stats: InstanceStats,
    chook: CombinedAgentHook,
    traj_path: Option<PathBuf>,
    problem_statement: Option<Box<dyn ProblemStatement>>,
    env: Option<Arc<tokio::sync::Mutex<SWEEnv>>>,
    output_dir: Option<PathBuf>,
    retry_loop: Option<Box<dyn RetryLoop>>,
}

impl RetryAgent {
    pub fn new(config: RetryAgentConfig) -> Self {
        Self {
            config,
            hooks: Vec::new(),
            i_attempt: 0,
            agent: None,
            attempt_data: Vec::new(),
            total_instance_stats: InstanceStats::default(),
            chook: CombinedAgentHook::new(),
            traj_path: None,
            problem_statement: None,
            env: None,
            output_dir: None,
            retry_loop: None,
        }
    }

    pub fn from_config(config: RetryAgentConfig) -> Self {
        Self::new(config)
    }

    fn setup_agent(&mut self) -> Result<()> {
        let agent_config_idx = self.i_attempt % self.config.agent_configs.len();
        let agent_config = self.config.agent_configs[agent_config_idx].clone();

        self.agent = Some(DefaultAgent::from_config(agent_config)?);

        // Add hooks to agent
        if let Some(ref mut _agent) = self.agent {
            for _hook in &self.hooks {
                // Can't clone hooks, so we skip this
            }
        }

        Ok(())
    }

    fn next_attempt(&mut self) -> Result<()> {
        self.i_attempt += 1;

        // Reset environment if possible
        if let Some(ref _env) = self.env {
            // Would call hard_reset here
        }

        self.setup_agent()
    }

    fn finalize_agent_run(&mut self) {
        if let Some(ref agent) = self.agent {
            self.attempt_data.push(agent.get_trajectory_data());
            self.total_instance_stats = self.total_instance_stats.add(&agent.model.get_stats());
        }
    }

    fn save_trajectory(&self, choose: bool) -> Result<()> {
        if let Some(ref path) = self.traj_path {
            let data = self.get_trajectory_data_internal(choose);
            let json = serde_json::to_string_pretty(&data)?;
            std::fs::write(path, json)?;
        }
        Ok(())
    }

    fn get_trajectory_data_internal(&self, choose: bool) -> serde_json::Value {
        let mut data = serde_json::json!({
            "attempts": self.attempt_data,
        });

        if choose && !self.attempt_data.is_empty() {
            let best_idx = self
                .retry_loop
                .as_ref()
                .and_then(|rl| rl.get_best())
                .unwrap_or(0);

            if best_idx < self.attempt_data.len() {
                data["info"] = serde_json::to_value(&self.attempt_data[best_idx].info).unwrap();
                data["info"]["best_attempt_idx"] = serde_json::Value::from(best_idx);
                data["trajectory"] =
                    serde_json::to_value(&self.attempt_data[best_idx].trajectory).unwrap();
            }
        }

        data
    }
}

#[async_trait]
impl Agent for RetryAgent {
    fn add_hook(&mut self, hook: Box<dyn AgentHook>) {
        self.chook.add_hook(hook);
    }

    fn get_trajectory_data(&self) -> TrajectoryData {
        if let Some(ref agent) = self.agent {
            agent.get_trajectory_data()
        } else if !self.attempt_data.is_empty() {
            self.attempt_data.last().unwrap().clone()
        } else {
            TrajectoryData {
                trajectory: Vec::new(),
                history: Vec::new(),
                info: AgentInfo::default(),
                replay_config: None,
                environment: "unknown".to_string(),
            }
        }
    }

    async fn step(&mut self) -> Result<StepOutput> {
        if let Some(ref mut agent) = self.agent {
            agent.step().await
        } else {
            Err(SWEAgentError::RuntimeError(
                "Agent not initialized".to_string(),
            ))
        }
    }

    async fn run(
        &mut self,
        env: &mut SWEEnv,
        problem_statement: Box<dyn ProblemStatement>,
        output_dir: &Path,
    ) -> Result<AgentRunResult> {
        std::fs::create_dir_all(output_dir)?;

        self.traj_path = Some(output_dir.join(format!("{}.traj", problem_statement.id())));
        self.problem_statement = Some(problem_statement);
        self.output_dir = Some(output_dir.to_path_buf());

        self.retry_loop = Some(get_retry_loop_from_config(&self.config.retry_loop));

        let env_arc = Arc::new(tokio::sync::Mutex::new(std::mem::take(env)));
        self.env = Some(env_arc.clone());

        self.chook.on_run_start();
        let mut step_output = StepOutput::default();

        self.setup_agent()?;

        // Setup agent with environment
        if let (Some(ref mut agent), Some(ref ps)) = (&mut self.agent, &self.problem_statement) {
            // Clone problem statement for agent
            let ps_clone = create_problem_statement(&ProblemStatementConfig::Text {
                text: ps.get_problem_statement(),
                id: ps.id().to_string(),
            })?;

            agent.setup(env_arc.clone(), ps_clone, output_dir).await?;
        }

        while !step_output.done {
            step_output = self.step().await?;
            let _ = self.save_trajectory(false);

            if step_output.done {
                let traj_data = self.get_trajectory_data();
                if let Some(ref mut retry_loop) = self.retry_loop {
                    retry_loop.on_submit(ReviewSubmission {
                        trajectory: traj_data.trajectory,
                        info: traj_data.info,
                        submission: step_output.submission.clone(),
                    });
                }

                self.finalize_agent_run();
                let _ = self.save_trajectory(false);

                if let Some(ref retry_loop) = self.retry_loop {
                    if retry_loop.should_retry() {
                        self.next_attempt()?;
                        step_output.done = false;
                    }
                }
            }
        }

        let _ = self.save_trajectory(true);

        if let Some(ref agent) = self.agent {
            self.chook.on_run_done(&agent.trajectory, &agent.info);
        }

        tracing::info!(path = ?self.traj_path, "Trajectory saved");

        // Restore env
        let restored_env = Arc::try_unwrap(env_arc)
            .map_err(|_| SWEAgentError::RuntimeError("Could not restore environment".to_string()))?
            .into_inner();
        *env = restored_env;

        Ok(AgentRunResult {
            info: self.get_trajectory_data().info,
            trajectory: self.get_trajectory_data().trajectory,
        })
    }
}

/// Union type for agent configurations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentConfig {
    Default(Box<DefaultAgentConfig>),
    Retry(RetryAgentConfig),
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self::Default(Box::default())
    }
}

/// Create an agent from configuration
pub fn get_agent_from_config(config: AgentConfig) -> Result<Box<dyn Agent>> {
    match config {
        AgentConfig::Default(cfg) => Ok(Box::new(DefaultAgent::from_config(*cfg)?)),
        AgentConfig::Retry(cfg) => Ok(Box::new(RetryAgent::from_config(cfg))),
    }
}

// Re-exports for convenience
pub use super::hooks::AgentHook as AbstractAgentHook;
pub use super::models::Model as AbstractModel;
