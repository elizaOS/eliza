//! Repository management for SWE-agent

use crate::exceptions::{Result, SWEAgentError};
use crate::utils::github::{parse_github_repo_url, GithubRepoInfo};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Trait for repository sources
pub trait Repo: Send + Sync {
    /// Get the repository name
    fn repo_name(&self) -> &str;

    /// Get the clone URL if available
    fn clone_url(&self) -> Option<&str>;

    /// Get the local path if available
    fn local_path(&self) -> Option<&Path>;

    /// Get the base commit if specified
    fn base_commit(&self) -> Option<&str>;
}

/// Pre-existing repository already in the environment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreExistingRepo {
    pub repo_name: String,
    pub path: PathBuf,
}

impl PreExistingRepo {
    pub fn new(repo_name: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            repo_name: repo_name.into(),
            path: path.into(),
        }
    }
}

impl Repo for PreExistingRepo {
    fn repo_name(&self) -> &str {
        &self.repo_name
    }

    fn clone_url(&self) -> Option<&str> {
        None
    }

    fn local_path(&self) -> Option<&Path> {
        Some(&self.path)
    }

    fn base_commit(&self) -> Option<&str> {
        None
    }
}

/// Local repository on the filesystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRepo {
    pub path: PathBuf,
    pub repo_name: String,
    pub base_commit: Option<String>,
}

impl LocalRepo {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let repo_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("local-repo")
            .to_string();

        if !path.exists() {
            return Err(SWEAgentError::FileNotFound(format!(
                "Repository path does not exist: {}",
                path.display()
            )));
        }

        Ok(Self {
            path,
            repo_name,
            base_commit: None,
        })
    }

    pub fn with_base_commit(mut self, commit: impl Into<String>) -> Self {
        self.base_commit = Some(commit.into());
        self
    }
}

impl Repo for LocalRepo {
    fn repo_name(&self) -> &str {
        &self.repo_name
    }

    fn clone_url(&self) -> Option<&str> {
        None
    }

    fn local_path(&self) -> Option<&Path> {
        Some(&self.path)
    }

    fn base_commit(&self) -> Option<&str> {
        self.base_commit.as_deref()
    }
}

/// GitHub repository
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepo {
    pub github_url: String,
    pub info: Option<GithubRepoInfo>,
    pub base_commit: Option<String>,
    pub clone_timeout: u64,
}

impl GithubRepo {
    pub fn new(github_url: impl Into<String>) -> Result<Self> {
        let url = github_url.into();
        let info = parse_github_repo_url(&url)?;

        Ok(Self {
            github_url: url,
            info: Some(info),
            base_commit: None,
            clone_timeout: 300,
        })
    }

    pub fn with_base_commit(mut self, commit: impl Into<String>) -> Self {
        self.base_commit = Some(commit.into());
        self
    }

    pub fn with_clone_timeout(mut self, timeout: u64) -> Self {
        self.clone_timeout = timeout;
        self
    }
}

impl Repo for GithubRepo {
    fn repo_name(&self) -> &str {
        self.info
            .as_ref()
            .map(|i| i.full_name.as_str())
            .unwrap_or("unknown")
    }

    fn clone_url(&self) -> Option<&str> {
        Some(&self.github_url)
    }

    fn local_path(&self) -> Option<&Path> {
        None
    }

    fn base_commit(&self) -> Option<&str> {
        self.base_commit.as_deref()
    }
}

/// Configuration for pre-existing repository
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreExistingRepoConfig {
    pub repo_name: String,
    pub path: String,
}

/// Configuration for local repository
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRepoConfig {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
}

/// Configuration for GitHub repository
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepoConfig {
    pub github_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(default = "default_clone_timeout")]
    pub clone_timeout: u64,
}

fn default_clone_timeout() -> u64 {
    300
}

/// Union type for repository configurations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RepoConfig {
    PreExisting(PreExistingRepoConfig),
    Local(LocalRepoConfig),
    Github(GithubRepoConfig),
}

/// Create a repository from simplified input
pub fn repo_from_simplified_input(input: &str) -> Result<Box<dyn Repo>> {
    // Check if it's a GitHub URL
    if input.starts_with("https://github.com/") || input.starts_with("git@github.com:") {
        return Ok(Box::new(GithubRepo::new(input)?));
    }

    // Check if it's a local path
    let path = Path::new(input);
    if path.exists() {
        return Ok(Box::new(LocalRepo::new(path)?));
    }

    Err(SWEAgentError::InvalidConfiguration(format!(
        "Could not parse repository input: {}",
        input
    )))
}

/// Create a repository from configuration
pub fn create_repo(config: &RepoConfig) -> Result<Box<dyn Repo>> {
    match config {
        RepoConfig::PreExisting(cfg) => Ok(Box::new(PreExistingRepo::new(
            cfg.repo_name.clone(),
            &cfg.path,
        ))),
        RepoConfig::Local(cfg) => {
            let mut repo = LocalRepo::new(&cfg.path)?;
            if let Some(ref commit) = cfg.base_commit {
                repo = repo.with_base_commit(commit.clone());
            }
            Ok(Box::new(repo))
        }
        RepoConfig::Github(cfg) => {
            let mut repo = GithubRepo::new(&cfg.github_url)?;
            if let Some(ref commit) = cfg.base_commit {
                repo = repo.with_base_commit(commit.clone());
            }
            repo = repo.with_clone_timeout(cfg.clone_timeout);
            Ok(Box::new(repo))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_github_repo() {
        let repo = GithubRepo::new("https://github.com/elizaos/eliza").unwrap();
        assert_eq!(repo.repo_name(), "elizaos/eliza");
        assert!(repo.clone_url().is_some());
    }

    #[test]
    fn test_pre_existing_repo() {
        let repo = PreExistingRepo::new("test-repo", "/tmp/test");
        assert_eq!(repo.repo_name(), "test-repo");
        assert!(repo.local_path().is_some());
    }
}
