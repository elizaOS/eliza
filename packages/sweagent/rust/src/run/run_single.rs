//! Single instance runner for SWE-agent

use super::hooks::{CombinedRunHook, RunHook};
use crate::agent::problem_statement::{
    create_problem_statement, ProblemStatement, ProblemStatementConfig,
};
use crate::agent::{get_agent_from_config, Agent, AgentConfig};
use crate::environment::{EnvironmentConfig, SWEEnv};
use crate::exceptions::Result;
use crate::types::AgentRunResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Actions to perform after agent run
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RunSingleActionConfig {
    #[serde(default)]
    pub open_pr: bool,
    #[serde(default)]
    pub apply_patch_locally: bool,
}

/// Configuration for running a single instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSingleConfig {
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub env: EnvironmentConfig,
    #[serde(default)]
    pub problem_statement: ProblemStatementConfig,
    #[serde(default = "default_output_dir")]
    pub output_dir: String,
    #[serde(default)]
    pub actions: RunSingleActionConfig,
}

fn default_output_dir() -> String {
    "./trajectories".to_string()
}

impl Default for RunSingleConfig {
    fn default() -> Self {
        Self {
            agent: AgentConfig::default(),
            env: EnvironmentConfig::default(),
            problem_statement: ProblemStatementConfig::Empty,
            output_dir: default_output_dir(),
            actions: RunSingleActionConfig::default(),
        }
    }
}

/// Runner for a single problem instance
pub struct RunSingle {
    agent: Box<dyn Agent>,
    env: SWEEnv,
    problem_statement: Box<dyn ProblemStatement>,
    output_dir: PathBuf,
    actions: RunSingleActionConfig,
    hooks: CombinedRunHook,
}

impl RunSingle {
    pub fn new(
        agent: Box<dyn Agent>,
        env: SWEEnv,
        problem_statement: Box<dyn ProblemStatement>,
        output_dir: impl Into<PathBuf>,
        actions: RunSingleActionConfig,
    ) -> Self {
        Self {
            agent,
            env,
            problem_statement,
            output_dir: output_dir.into(),
            actions,
            hooks: CombinedRunHook::new(),
        }
    }

    /// Create from configuration
    pub fn from_config(config: RunSingleConfig) -> Result<Self> {
        let agent = get_agent_from_config(config.agent)?;
        let env = SWEEnv::from_config(config.env)?;
        let problem_statement = create_problem_statement(&config.problem_statement)?;

        Ok(Self::new(
            agent,
            env,
            problem_statement,
            config.output_dir,
            config.actions,
        ))
    }

    /// Add a hook
    pub fn add_hook(&mut self, hook: Box<dyn RunHook>) {
        self.hooks.add_hook(hook);
    }

    /// Run the agent on the problem instance
    pub async fn run(&mut self) -> Result<AgentRunResult> {
        // Ensure output directory exists
        std::fs::create_dir_all(&self.output_dir)?;

        self.hooks.on_start();
        self.hooks.on_instance_start(0, self.problem_statement.id());

        // Start the environment
        self.env.start().await?;

        // Create a new problem statement for the agent (since we need to move it)
        let ps_config = ProblemStatementConfig::Text {
            text: self.problem_statement.get_problem_statement(),
            id: self.problem_statement.id().to_string(),
        };
        let ps_for_agent = create_problem_statement(&ps_config)?;

        // Run the agent
        let result = match self
            .agent
            .run(&mut self.env, ps_for_agent, &self.output_dir)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "Agent run failed");
                self.env.stop().await?;
                return Err(e);
            }
        };

        // Stop the environment
        self.env.stop().await?;

        self.hooks.on_instance_completed(&result);
        self.hooks.on_end();

        // Handle post-run actions
        if self.actions.apply_patch_locally {
            self.apply_patch_locally(&result).await?;
        }

        if self.actions.open_pr {
            self.open_pr(&result).await?;
        }

        Ok(result)
    }

    async fn apply_patch_locally(&self, result: &AgentRunResult) -> Result<()> {
        if let Some(ref submission) = result.info.submission {
            tracing::info!("Applying patch locally");
            // In a full implementation, would apply the patch using git
            let patch_path = self.output_dir.join("local.patch");
            std::fs::write(&patch_path, submission)?;
            tracing::info!(path = ?patch_path, "Patch saved");
        }
        Ok(())
    }

    async fn open_pr(&self, result: &AgentRunResult) -> Result<()> {
        if result.info.submission.is_some() {
            tracing::info!("Opening PR");
            // In a full implementation, would create a GitHub PR
        }
        Ok(())
    }
}

/// Run from configuration (convenience function)
pub async fn run_from_config(config: RunSingleConfig) -> Result<AgentRunResult> {
    let mut runner = RunSingle::from_config(config)?;
    runner.run().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::DeploymentConfig;

    #[tokio::test]
    async fn test_run_single_creation() {
        let config = RunSingleConfig {
            env: EnvironmentConfig {
                deployment: DeploymentConfig::Mock,
                ..Default::default()
            },
            ..Default::default()
        };

        let runner = RunSingle::from_config(config);
        assert!(runner.is_ok());
    }
}
