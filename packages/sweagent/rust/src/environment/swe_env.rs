//! SWE-agent environment implementation

use super::deployment::{get_deployment, Deployment, DeploymentConfig};
use super::hooks::{CombinedEnvironmentHook, EnvironmentHook};
use super::repo::{create_repo, Repo, RepoConfig};
use crate::exceptions::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Configuration for the SWE environment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentConfig {
    #[serde(default)]
    pub deployment: DeploymentConfig,
    #[serde(default)]
    pub post_startup_commands: Vec<String>,
    #[serde(default = "default_post_startup_timeout")]
    pub post_startup_command_timeout: u64,
    #[serde(default)]
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoConfig>,
}

fn default_post_startup_timeout() -> u64 {
    120
}

impl Default for EnvironmentConfig {
    fn default() -> Self {
        Self {
            deployment: DeploymentConfig::default(),
            post_startup_commands: Vec::new(),
            post_startup_command_timeout: default_post_startup_timeout(),
            name: "swe-env".to_string(),
            repo: None,
        }
    }
}

/// The main SWE-agent environment
pub struct SWEEnv {
    pub name: String,
    deployment: Box<dyn Deployment>,
    repo: Option<Box<dyn Repo>>,
    post_startup_commands: Vec<String>,
    post_startup_command_timeout: u64,
    hooks: CombinedEnvironmentHook,
    env_variables: HashMap<String, String>,
    open_files: Vec<String>,
}

impl Default for SWEEnv {
    fn default() -> Self {
        Self {
            name: "swe-env".to_string(),
            deployment: get_deployment(DeploymentConfig::default()),
            repo: None,
            post_startup_commands: Vec::new(),
            post_startup_command_timeout: default_post_startup_timeout(),
            hooks: CombinedEnvironmentHook::new(),
            env_variables: HashMap::new(),
            open_files: Vec::new(),
        }
    }
}

impl SWEEnv {
    pub fn new(config: EnvironmentConfig) -> Result<Self> {
        let deployment = get_deployment(config.deployment);
        let repo = config.repo.as_ref().map(create_repo).transpose()?;

        Ok(Self {
            name: config.name,
            deployment,
            repo,
            post_startup_commands: config.post_startup_commands,
            post_startup_command_timeout: config.post_startup_command_timeout,
            hooks: CombinedEnvironmentHook::new(),
            env_variables: HashMap::new(),
            open_files: Vec::new(),
        })
    }

    pub fn from_config(config: EnvironmentConfig) -> Result<Self> {
        Self::new(config)
    }

    /// Add a hook to the environment
    pub fn add_hook(&mut self, hook: Box<dyn EnvironmentHook>) {
        self.hooks.add_hook(hook);
    }

    /// Start the environment
    pub async fn start(&mut self) -> Result<()> {
        self.hooks.on_start();
        self.deployment.start().await?;

        // Run post-startup commands
        for cmd in &self.post_startup_commands.clone() {
            self.communicate(cmd, Some(self.post_startup_command_timeout))
                .await?;
        }

        Ok(())
    }

    /// Stop the environment
    pub async fn stop(&mut self) -> Result<()> {
        self.hooks.on_stop();
        self.deployment.stop().await
    }

    /// Check if the environment is running
    pub fn is_running(&self) -> bool {
        self.deployment.is_running()
    }

    /// Execute a command in the environment
    pub async fn communicate(&self, command: &str, timeout: Option<u64>) -> Result<String> {
        let output = self.deployment.execute(command, timeout).await?;
        // Note: hooks require mut self, but we're in a shared context
        // In production, use Arc<Mutex<CombinedEnvironmentHook>> for proper mutability
        Ok(output)
    }

    /// Read a file from the environment
    pub async fn read_file(&self, path: &str) -> Result<String> {
        self.deployment.read_file(path).await
    }

    /// Write a file to the environment
    pub async fn write_file(&self, path: &str, content: &str) -> Result<()> {
        self.deployment.write_file(path, content).await
    }

    /// Set environment variables
    pub async fn set_env_variables(&mut self, vars: HashMap<String, String>) -> Result<()> {
        self.env_variables.extend(vars.clone());

        // Export variables in the shell
        for (key, value) in vars {
            let cmd = format!("export {}='{}'", key, value);
            self.communicate(&cmd, Some(5)).await?;
        }

        Ok(())
    }

    /// Interrupt the current session
    pub async fn interrupt_session(&self) -> Result<()> {
        self.deployment.interrupt().await
    }

    /// Get the current working directory
    pub fn get_cwd(&self) -> Option<String> {
        self.deployment.get_cwd()
    }

    /// Get the list of open files
    pub fn get_open_files(&self) -> &[String] {
        &self.open_files
    }

    /// Add a file to the open files list
    pub fn add_open_file(&mut self, file: impl Into<String>) {
        let f = file.into();
        if !self.open_files.contains(&f) {
            self.open_files.push(f);
        }
    }

    /// Remove a file from the open files list
    pub fn remove_open_file(&mut self, file: &str) {
        self.open_files.retain(|f| f != file);
    }

    /// Get git status
    pub async fn get_git_status(&self) -> Result<String> {
        self.communicate("git status --porcelain", Some(30)).await
    }

    /// Get git diff
    pub async fn get_git_diff(&self) -> Result<String> {
        self.communicate("git diff", Some(60)).await
    }

    /// Hard reset the environment
    pub async fn hard_reset(&mut self) -> Result<()> {
        self.hooks.on_reset();

        // Reset git state if in a repo
        if self.repo.is_some() {
            self.communicate("git checkout .", Some(30)).await?;
            self.communicate("git clean -fd", Some(30)).await?;
        }

        // Clear open files
        self.open_files.clear();

        Ok(())
    }

    /// Get repository name if available
    pub fn repo_name(&self) -> Option<&str> {
        self.repo.as_ref().map(|r| r.repo_name())
    }

    /// Check if environment is alive
    pub fn is_alive(&self) -> bool {
        self.deployment.is_running()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_swe_env_creation() {
        let config = EnvironmentConfig {
            deployment: DeploymentConfig::Mock,
            ..Default::default()
        };

        let mut env = SWEEnv::new(config).unwrap();
        env.start().await.unwrap();

        assert!(env.is_running());

        env.stop().await.unwrap();
        assert!(!env.is_running());
    }

    #[tokio::test]
    async fn test_swe_env_communicate() {
        let config = EnvironmentConfig {
            deployment: DeploymentConfig::Mock,
            ..Default::default()
        };

        let mut env = SWEEnv::new(config).unwrap();
        env.start().await.unwrap();

        let output = env.communicate("pwd", Some(5)).await.unwrap();
        assert!(!output.is_empty());
    }
}
