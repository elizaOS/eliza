//! Problem statement types for SWE-agent
//!
//! This module defines various ways to specify a problem for the agent to solve.

use crate::exceptions::{Result, SWEAgentError};
use crate::utils::github::{parse_github_issue_url, GithubIssueInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Trait for problem statements
pub trait ProblemStatement: Send + Sync {
    /// Get the problem statement text
    fn get_problem_statement(&self) -> String;

    /// Get the unique identifier for this problem
    fn id(&self) -> &str;

    /// Get any extra fields for template rendering
    fn get_extra_fields(&self) -> HashMap<String, String> {
        HashMap::new()
    }
}

/// Empty problem statement for testing
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmptyProblemStatement {
    #[serde(default = "default_empty_id")]
    pub id: String,
}

fn default_empty_id() -> String {
    "empty".to_string()
}

impl EmptyProblemStatement {
    pub fn new() -> Self {
        Self {
            id: default_empty_id(),
        }
    }
}

impl ProblemStatement for EmptyProblemStatement {
    fn get_problem_statement(&self) -> String {
        String::new()
    }

    fn id(&self) -> &str {
        &self.id
    }
}

/// Text-based problem statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextProblemStatement {
    pub text: String,
    pub id: String,
}

impl TextProblemStatement {
    pub fn new(text: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            id: id.into(),
        }
    }
}

impl ProblemStatement for TextProblemStatement {
    fn get_problem_statement(&self) -> String {
        self.text.clone()
    }

    fn id(&self) -> &str {
        &self.id
    }
}

/// Problem statement loaded from a file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileProblemStatement {
    pub path: String,
    pub id: String,
    #[serde(skip)]
    cached_text: Option<String>,
}

impl FileProblemStatement {
    pub fn new(path: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            id: id.into(),
            cached_text: None,
        }
    }

    pub fn load(&mut self) -> Result<()> {
        let content = std::fs::read_to_string(&self.path)?;
        self.cached_text = Some(content);
        Ok(())
    }
}

impl ProblemStatement for FileProblemStatement {
    fn get_problem_statement(&self) -> String {
        if let Some(ref text) = self.cached_text {
            return text.clone();
        }

        std::fs::read_to_string(&self.path).unwrap_or_default()
    }

    fn id(&self) -> &str {
        &self.id
    }
}

/// GitHub issue as a problem statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubIssue {
    pub github_url: String,
    #[serde(skip)]
    pub info: Option<GithubIssueInfo>,
    #[serde(skip)]
    pub title: Option<String>,
    #[serde(skip)]
    pub body: Option<String>,
}

impl GithubIssue {
    pub fn new(github_url: impl Into<String>) -> Result<Self> {
        let url = github_url.into();
        let info = parse_github_issue_url(&url)?;
        Ok(Self {
            github_url: url,
            info: Some(info),
            title: None,
            body: None,
        })
    }

    /// Fetch issue data from GitHub API
    pub async fn fetch(&mut self) -> Result<()> {
        let info = self.info.as_ref().ok_or_else(|| {
            SWEAgentError::InvalidGithubUrl("No issue info available".to_string())
        })?;

        let client = reqwest::Client::new();
        let api_url = format!(
            "https://api.github.com/repos/{}/{}/issues/{}",
            info.owner, info.repo, info.issue_number
        );

        let response = client
            .get(&api_url)
            .header("User-Agent", "swe-agent-rust")
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(SWEAgentError::ApiError(format!(
                "Failed to fetch issue: {}",
                response.status()
            )));
        }

        let data: serde_json::Value = response.json().await?;

        self.title = data["title"].as_str().map(String::from);
        self.body = data["body"].as_str().map(String::from);

        Ok(())
    }
}

impl ProblemStatement for GithubIssue {
    fn get_problem_statement(&self) -> String {
        let title = self.title.as_deref().unwrap_or("(No title)");
        let body = self.body.as_deref().unwrap_or("(No description)");
        format!("# {}\n\n{}", title, body)
    }

    fn id(&self) -> &str {
        self.info
            .as_ref()
            .map(|i| i.full_name.as_str())
            .unwrap_or("unknown")
    }

    fn get_extra_fields(&self) -> HashMap<String, String> {
        let mut fields = HashMap::new();
        if let Some(ref info) = self.info {
            fields.insert("github_owner".to_string(), info.owner.clone());
            fields.insert("github_repo".to_string(), info.repo.clone());
            fields.insert("issue_number".to_string(), info.issue_number.to_string());
        }
        fields
    }
}

/// SWE-Bench multimodal problem statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SWEBenchMultimodalProblemStatement {
    pub instance_id: String,
    pub problem_statement: String,
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub hints: Vec<String>,
}

impl SWEBenchMultimodalProblemStatement {
    pub fn new(instance_id: impl Into<String>, problem_statement: impl Into<String>) -> Self {
        Self {
            instance_id: instance_id.into(),
            problem_statement: problem_statement.into(),
            image_urls: Vec::new(),
            hints: Vec::new(),
        }
    }
}

impl ProblemStatement for SWEBenchMultimodalProblemStatement {
    fn get_problem_statement(&self) -> String {
        self.problem_statement.clone()
    }

    fn id(&self) -> &str {
        &self.instance_id
    }

    fn get_extra_fields(&self) -> HashMap<String, String> {
        let mut fields = HashMap::new();
        if !self.hints.is_empty() {
            fields.insert("hints".to_string(), self.hints.join("\n"));
        }
        fields
    }
}

/// Configuration for problem statements
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProblemStatementConfig {
    #[default]
    Empty,
    Text {
        text: String,
        id: String,
    },
    File {
        path: String,
        id: String,
    },
    GithubIssue {
        github_url: String,
    },
    SweBenchMultimodal {
        instance_id: String,
        problem_statement: String,
        #[serde(default)]
        image_urls: Vec<String>,
    },
}

/// Create a problem statement from simplified input
pub fn problem_statement_from_simplified_input(input: &str) -> Result<Box<dyn ProblemStatement>> {
    // Check if it's a GitHub URL
    if input.starts_with("https://github.com/") && input.contains("/issues/") {
        let issue = GithubIssue::new(input)?;
        return Ok(Box::new(issue));
    }

    // Check if it's a file path
    if Path::new(input).exists() {
        let id = Path::new(input)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let mut statement = FileProblemStatement::new(input, id);
        statement.load()?;
        return Ok(Box::new(statement));
    }

    // Treat as plain text
    let id = format!(
        "text_{}",
        uuid::Uuid::new_v4().to_string().split('-').next().unwrap()
    );
    Ok(Box::new(TextProblemStatement::new(input, id)))
}

/// Create a problem statement from configuration
pub fn create_problem_statement(
    config: &ProblemStatementConfig,
) -> Result<Box<dyn ProblemStatement>> {
    match config {
        ProblemStatementConfig::Empty => Ok(Box::new(EmptyProblemStatement::new())),
        ProblemStatementConfig::Text { text, id } => Ok(Box::new(TextProblemStatement::new(
            text.clone(),
            id.clone(),
        ))),
        ProblemStatementConfig::File { path, id } => {
            let mut statement = FileProblemStatement::new(path.clone(), id.clone());
            statement.load()?;
            Ok(Box::new(statement))
        }
        ProblemStatementConfig::GithubIssue { github_url } => {
            let issue = GithubIssue::new(github_url)?;
            Ok(Box::new(issue))
        }
        ProblemStatementConfig::SweBenchMultimodal {
            instance_id,
            problem_statement,
            image_urls,
        } => {
            let mut stmt = SWEBenchMultimodalProblemStatement::new(
                instance_id.clone(),
                problem_statement.clone(),
            );
            stmt.image_urls = image_urls.clone();
            Ok(Box::new(stmt))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_problem_statement() {
        let ps = EmptyProblemStatement::new();
        assert_eq!(ps.get_problem_statement(), "");
        assert_eq!(ps.id(), "empty");
    }

    #[test]
    fn test_text_problem_statement() {
        let ps = TextProblemStatement::new("Fix the bug", "bug-123");
        assert_eq!(ps.get_problem_statement(), "Fix the bug");
        assert_eq!(ps.id(), "bug-123");
    }

    #[test]
    fn test_github_issue_parsing() {
        let issue = GithubIssue::new("https://github.com/owner/repo/issues/42").unwrap();
        let info = issue.info.unwrap();
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.issue_number, 42);
    }
}
