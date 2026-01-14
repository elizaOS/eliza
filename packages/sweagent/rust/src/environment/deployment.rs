//! Deployment implementations for SWE-agent environments

use crate::exceptions::{Result, SWEAgentError};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Trait for deployment backends
#[async_trait]
pub trait Deployment: Send + Sync {
    /// Start the deployment
    async fn start(&mut self) -> Result<()>;

    /// Stop the deployment
    async fn stop(&mut self) -> Result<()>;

    /// Check if deployment is running
    fn is_running(&self) -> bool;

    /// Execute a command in the deployment
    async fn execute(&self, command: &str, timeout: Option<u64>) -> Result<String>;

    /// Read a file from the deployment
    async fn read_file(&self, path: &str) -> Result<String>;

    /// Write a file in the deployment
    async fn write_file(&self, path: &str, content: &str) -> Result<()>;

    /// Get the working directory
    fn get_cwd(&self) -> Option<String>;

    /// Interrupt the current command
    async fn interrupt(&self) -> Result<()>;
}

/// Configuration for Docker deployment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerDeploymentConfig {
    #[serde(default = "default_image")]
    pub image: String,
    #[serde(default)]
    pub python_standalone_dir: Option<String>,
    #[serde(default)]
    pub volumes: HashMap<String, String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub remove_on_stop: bool,
    #[serde(default = "default_workdir")]
    pub work_dir: String,
}

fn default_image() -> String {
    "python:3.11".to_string()
}

fn default_true() -> bool {
    true
}

fn default_workdir() -> String {
    "/workspace".to_string()
}

impl Default for DockerDeploymentConfig {
    fn default() -> Self {
        Self {
            image: default_image(),
            python_standalone_dir: None,
            volumes: HashMap::new(),
            environment: HashMap::new(),
            remove_on_stop: true,
            work_dir: default_workdir(),
        }
    }
}

/// Docker-based deployment using docker CLI
pub struct DockerDeployment {
    config: DockerDeploymentConfig,
    container_id: Option<String>,
    is_running: bool,
    cwd: String,
}

impl DockerDeployment {
    pub fn new(config: DockerDeploymentConfig) -> Self {
        let cwd = config.work_dir.clone();
        Self {
            config,
            container_id: None,
            is_running: false,
            cwd,
        }
    }

    /// Execute docker command and return output
    async fn docker_cmd(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("docker")
            .args(args)
            .output()
            .await
            .map_err(|e| SWEAgentError::DockerError(format!("Failed to run docker: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(SWEAgentError::DockerError(format!(
                "Docker command failed: {}",
                stderr
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

#[async_trait]
impl Deployment for DockerDeployment {
    async fn start(&mut self) -> Result<()> {
        tracing::info!(image = %self.config.image, "Starting Docker container");

        // Build docker run command
        let mut args = vec![
            "run", "-d",   // detached
            "-it",  // interactive with tty for shell
            "--rm", // auto remove when stopped
        ];

        // Add working directory
        args.push("-w");
        args.push(&self.config.work_dir);

        // Add volume mounts
        let volume_args: Vec<String> = self
            .config
            .volumes
            .iter()
            .map(|(host, container)| format!("{}:{}", host, container))
            .collect();
        for vol in &volume_args {
            args.push("-v");
            args.push(vol);
        }

        // Add environment variables
        let env_args: Vec<String> = self
            .config
            .environment
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        for env in &env_args {
            args.push("-e");
            args.push(env);
        }

        // Add image and command (bash to keep it running)
        args.push(&self.config.image);
        args.push("bash");

        let container_id = self.docker_cmd(&args).await?;

        if container_id.is_empty() {
            return Err(SWEAgentError::DockerError(
                "Failed to get container ID".to_string(),
            ));
        }

        self.container_id = Some(container_id.clone());
        self.is_running = true;

        tracing::info!(container_id = %container_id, "Docker container started");
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        if let Some(ref container_id) = self.container_id {
            tracing::info!(container = %container_id, "Stopping Docker container");

            // Stop container (will auto-remove due to --rm)
            let _ = self.docker_cmd(&["stop", container_id]).await;
        }

        self.is_running = false;
        self.container_id = None;

        Ok(())
    }

    fn is_running(&self) -> bool {
        self.is_running
    }

    async fn execute(&self, command: &str, timeout: Option<u64>) -> Result<String> {
        let container_id = self
            .container_id
            .as_ref()
            .ok_or_else(|| SWEAgentError::EnvironmentError("Container not running".to_string()))?;

        if !self.is_running {
            return Err(SWEAgentError::EnvironmentError(
                "Container not running".to_string(),
            ));
        }

        let timeout_secs = timeout.unwrap_or(30);

        // Use docker exec with timeout
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            self.docker_cmd(&["exec", container_id, "bash", "-c", command]),
        )
        .await;

        match result {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(SWEAgentError::CommandTimeout {
                timeout: timeout_secs,
                command: command.to_string(),
            }),
        }
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        let container_id = self
            .container_id
            .as_ref()
            .ok_or_else(|| SWEAgentError::EnvironmentError("Container not running".to_string()))?;

        if !self.is_running {
            return Err(SWEAgentError::EnvironmentError(
                "Container not running".to_string(),
            ));
        }

        // Use docker exec cat to read file
        self.docker_cmd(&["exec", container_id, "cat", path])
            .await
            .map_err(|_| SWEAgentError::FileNotFound(path.to_string()))
    }

    async fn write_file(&self, path: &str, content: &str) -> Result<()> {
        let container_id = self
            .container_id
            .as_ref()
            .ok_or_else(|| SWEAgentError::EnvironmentError("Container not running".to_string()))?;

        if !self.is_running {
            return Err(SWEAgentError::EnvironmentError(
                "Container not running".to_string(),
            ));
        }

        // Create parent directories
        if let Some(parent) = std::path::Path::new(path).parent() {
            let mkdir_cmd = format!("mkdir -p {}", parent.display());
            let _ = self
                .docker_cmd(&["exec", container_id, "bash", "-c", &mkdir_cmd])
                .await;
        }

        // Use heredoc to write content - escape single quotes
        let escaped_content = content.replace('\'', "'\\''");
        let write_cmd = format!(
            "cat > '{}' << 'SWEAGENT_EOF'\n{}\nSWEAGENT_EOF",
            path, escaped_content
        );

        self.docker_cmd(&["exec", container_id, "bash", "-c", &write_cmd])
            .await?;

        Ok(())
    }

    fn get_cwd(&self) -> Option<String> {
        Some(self.cwd.clone())
    }

    async fn interrupt(&self) -> Result<()> {
        if let Some(ref container_id) = self.container_id {
            // Send SIGINT to all processes in container
            let _ = self
                .docker_cmd(&["exec", container_id, "pkill", "-INT", "-f", "."])
                .await;
        }
        Ok(())
    }
}

/// Local shell deployment (no Docker)
pub struct LocalDeployment {
    is_running: bool,
    cwd: String,
    #[allow(dead_code)]
    shell_process: Option<Arc<Mutex<Child>>>,
}

impl LocalDeployment {
    pub fn new(cwd: Option<String>) -> Self {
        Self {
            is_running: false,
            cwd: cwd.unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "/tmp".to_string())
            }),
            shell_process: None,
        }
    }
}

#[async_trait]
impl Deployment for LocalDeployment {
    async fn start(&mut self) -> Result<()> {
        self.is_running = true;
        tracing::info!(cwd = %self.cwd, "Local deployment started");
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        self.is_running = false;
        tracing::info!("Local deployment stopped");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.is_running
    }

    async fn execute(&self, command: &str, timeout: Option<u64>) -> Result<String> {
        if !self.is_running {
            return Err(SWEAgentError::EnvironmentError(
                "Deployment not running".to_string(),
            ));
        }

        let timeout_secs = timeout.unwrap_or(30);

        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), async {
            let output = Command::new("bash")
                .arg("-c")
                .arg(command)
                .current_dir(&self.cwd)
                .output()
                .await
                .map_err(|e| SWEAgentError::RuntimeError(e.to_string()))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if stderr.is_empty() {
                Ok(stdout.to_string())
            } else {
                Ok(format!("{}{}", stdout, stderr))
            }
        })
        .await;

        match result {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(SWEAgentError::CommandTimeout {
                timeout: timeout_secs,
                command: command.to_string(),
            }),
        }
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        let full_path = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            std::path::PathBuf::from(&self.cwd).join(path)
        };

        tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|_| SWEAgentError::FileNotFound(path.to_string()))
    }

    async fn write_file(&self, path: &str, content: &str) -> Result<()> {
        let full_path = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            std::path::PathBuf::from(&self.cwd).join(path)
        };

        // Create parent directories
        if let Some(parent) = full_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| SWEAgentError::IoError(e.to_string()))?;
        }

        tokio::fs::write(&full_path, content)
            .await
            .map_err(|e| SWEAgentError::IoError(e.to_string()))
    }

    fn get_cwd(&self) -> Option<String> {
        Some(self.cwd.clone())
    }

    async fn interrupt(&self) -> Result<()> {
        // For local deployment, we can't easily interrupt
        // The timeout mechanism handles this
        Ok(())
    }
}

/// Mock deployment for testing
pub struct MockDeployment {
    is_running: bool,
    cwd: String,
    files: std::sync::Mutex<HashMap<String, String>>,
    command_outputs: HashMap<String, String>,
}

impl MockDeployment {
    pub fn new() -> Self {
        Self {
            is_running: false,
            cwd: "/workspace".to_string(),
            files: std::sync::Mutex::new(HashMap::new()),
            command_outputs: HashMap::new(),
        }
    }

    pub fn with_file(self, path: impl Into<String>, content: impl Into<String>) -> Self {
        if let Ok(mut files) = self.files.lock() {
            files.insert(path.into(), content.into());
        }
        self
    }

    pub fn with_command_output(
        mut self,
        command: impl Into<String>,
        output: impl Into<String>,
    ) -> Self {
        self.command_outputs.insert(command.into(), output.into());
        self
    }

    /// Synchronous version for non-async contexts
    pub fn add_file(&self, path: impl Into<String>, content: impl Into<String>) {
        if let Ok(mut files) = self.files.lock() {
            files.insert(path.into(), content.into());
        }
    }
}

impl Default for MockDeployment {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Deployment for MockDeployment {
    async fn start(&mut self) -> Result<()> {
        self.is_running = true;
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        self.is_running = false;
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.is_running
    }

    async fn execute(&self, command: &str, _timeout: Option<u64>) -> Result<String> {
        if !self.is_running {
            return Err(SWEAgentError::EnvironmentError(
                "Mock not running".to_string(),
            ));
        }

        // Check for predefined outputs
        if let Some(output) = self.command_outputs.get(command) {
            return Ok(output.clone());
        }

        // Handle common commands
        if command == "pwd" {
            return Ok(self.cwd.clone());
        }

        // Handle cat command for reading files
        if command.starts_with("cat ") {
            let path = command.strip_prefix("cat ").unwrap().trim();
            let files = self
                .files
                .lock()
                .map_err(|e| SWEAgentError::RuntimeError(e.to_string()))?;
            if let Some(content) = files.get(path) {
                return Ok(content.clone());
            }
            return Err(SWEAgentError::FileNotFound(path.to_string()));
        }

        Ok(String::new())
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        let files = self
            .files
            .lock()
            .map_err(|e| SWEAgentError::RuntimeError(e.to_string()))?;
        files
            .get(path)
            .cloned()
            .ok_or_else(|| SWEAgentError::FileNotFound(path.to_string()))
    }

    async fn write_file(&self, path: &str, content: &str) -> Result<()> {
        let mut files = self
            .files
            .lock()
            .map_err(|e| SWEAgentError::RuntimeError(e.to_string()))?;
        files.insert(path.to_string(), content.to_string());
        Ok(())
    }

    fn get_cwd(&self) -> Option<String> {
        Some(self.cwd.clone())
    }

    async fn interrupt(&self) -> Result<()> {
        Ok(())
    }
}

/// Configuration for local deployment
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalDeploymentConfig {
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Configuration for deployments
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeploymentConfig {
    Docker(DockerDeploymentConfig),
    Local(LocalDeploymentConfig),
    Mock,
}

impl Default for DeploymentConfig {
    fn default() -> Self {
        Self::Docker(DockerDeploymentConfig::default())
    }
}

/// Create a deployment from configuration
pub fn get_deployment(config: DeploymentConfig) -> Box<dyn Deployment> {
    match config {
        DeploymentConfig::Docker(cfg) => Box::new(DockerDeployment::new(cfg)),
        DeploymentConfig::Local(cfg) => Box::new(LocalDeployment::new(cfg.cwd)),
        DeploymentConfig::Mock => Box::new(MockDeployment::new()),
    }
}

// Re-export for convenience
pub use DockerDeployment as AbstractDeployment;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mock_deployment() {
        let mut deployment = MockDeployment::new();

        // Start the deployment first
        deployment.start().await.unwrap();
        assert!(deployment.is_running());

        // Write a file
        deployment
            .write_file("/test.txt", "hello world")
            .await
            .unwrap();

        // Read it back
        let content = deployment.read_file("/test.txt").await.unwrap();
        assert_eq!(content, "hello world");

        deployment.stop().await.unwrap();
        assert!(!deployment.is_running());
    }

    #[tokio::test]
    async fn test_local_deployment_execute() {
        let mut deployment = LocalDeployment::new(Some("/tmp".to_string()));
        deployment.start().await.unwrap();

        let output = deployment.execute("echo hello", Some(5)).await.unwrap();
        assert!(output.contains("hello"));

        deployment.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_local_deployment_file_ops() {
        let mut deployment = LocalDeployment::new(Some("/tmp".to_string()));
        deployment.start().await.unwrap();

        let test_file = "/tmp/sweagent_test_file.txt";
        deployment
            .write_file(test_file, "test content")
            .await
            .unwrap();

        let content = deployment.read_file(test_file).await.unwrap();
        assert_eq!(content, "test content");

        // Cleanup
        let _ = tokio::fs::remove_file(test_file).await;

        deployment.stop().await.unwrap();
    }
}
