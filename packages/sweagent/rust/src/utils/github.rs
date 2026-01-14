//! GitHub utilities for SWE-agent

use crate::exceptions::{Result, SWEAgentError};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Parsed GitHub repository information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepoInfo {
    pub owner: String,
    pub repo: String,
    pub full_name: String,
}

/// Parsed GitHub issue information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubIssueInfo {
    pub owner: String,
    pub repo: String,
    pub issue_number: u64,
    pub full_name: String,
}

/// Check if a string is a GitHub repository URL
pub fn is_github_repo_url(url: &str) -> bool {
    let patterns = [
        r"^https?://github\.com/[\w.-]+/[\w.-]+/?$",
        r"^https?://github\.com/[\w.-]+/[\w.-]+\.git$",
        r"^git@github\.com:[\w.-]+/[\w.-]+\.git$",
    ];

    patterns
        .iter()
        .any(|p| Regex::new(p).map(|re| re.is_match(url)).unwrap_or(false))
}

/// Check if a string is a GitHub issue URL
pub fn is_github_issue_url(url: &str) -> bool {
    let pattern = r"^https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+$";
    Regex::new(pattern)
        .map(|re| re.is_match(url))
        .unwrap_or(false)
}

/// Parse a GitHub repository URL
pub fn parse_github_repo_url(url: &str) -> Result<GithubRepoInfo> {
    // Handle HTTPS URLs
    let https_pattern = Regex::new(r"^https?://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")
        .map_err(|e| SWEAgentError::Unknown(e.to_string()))?;

    if let Some(caps) = https_pattern.captures(url) {
        let owner = caps.get(1).unwrap().as_str().to_string();
        let repo = caps.get(2).unwrap().as_str().to_string();
        return Ok(GithubRepoInfo {
            full_name: format!("{}/{}", owner, repo),
            owner,
            repo,
        });
    }

    // Handle SSH URLs
    let ssh_pattern = Regex::new(r"^git@github\.com:([\w.-]+)/([\w.-]+?)(?:\.git)?$")
        .map_err(|e| SWEAgentError::Unknown(e.to_string()))?;

    if let Some(caps) = ssh_pattern.captures(url) {
        let owner = caps.get(1).unwrap().as_str().to_string();
        let repo = caps.get(2).unwrap().as_str().to_string();
        return Ok(GithubRepoInfo {
            full_name: format!("{}/{}", owner, repo),
            owner,
            repo,
        });
    }

    Err(SWEAgentError::InvalidGithubUrl(format!(
        "Could not parse GitHub URL: {}",
        url
    )))
}

/// Parse a GitHub issue URL
pub fn parse_github_issue_url(url: &str) -> Result<GithubIssueInfo> {
    let pattern = Regex::new(r"^https?://github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+)$")
        .map_err(|e| SWEAgentError::Unknown(e.to_string()))?;

    if let Some(caps) = pattern.captures(url) {
        let owner = caps.get(1).unwrap().as_str().to_string();
        let repo = caps.get(2).unwrap().as_str().to_string();
        let issue_number: u64 = caps
            .get(3)
            .unwrap()
            .as_str()
            .parse()
            .map_err(|_| SWEAgentError::InvalidGithubUrl("Invalid issue number".to_string()))?;

        return Ok(GithubIssueInfo {
            full_name: format!("{}/{}", owner, repo),
            owner,
            repo,
            issue_number,
        });
    }

    Err(SWEAgentError::InvalidGithubUrl(format!(
        "Could not parse GitHub issue URL: {}",
        url
    )))
}

/// Build a GitHub repository URL from owner and repo
pub fn build_github_repo_url(owner: &str, repo: &str) -> String {
    format!("https://github.com/{}/{}", owner, repo)
}

/// Build a GitHub issue URL
pub fn build_github_issue_url(owner: &str, repo: &str, issue_number: u64) -> String {
    format!(
        "https://github.com/{}/{}/issues/{}",
        owner, repo, issue_number
    )
}

/// Build a GitHub raw content URL
pub fn build_github_raw_url(owner: &str, repo: &str, branch: &str, path: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        owner, repo, branch, path
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_github_repo_url() {
        assert!(is_github_repo_url("https://github.com/owner/repo"));
        assert!(is_github_repo_url("https://github.com/owner/repo/"));
        assert!(is_github_repo_url("https://github.com/owner/repo.git"));
        assert!(is_github_repo_url("git@github.com:owner/repo.git"));
        assert!(!is_github_repo_url("https://gitlab.com/owner/repo"));
        assert!(!is_github_repo_url("not a url"));
    }

    #[test]
    fn test_is_github_issue_url() {
        assert!(is_github_issue_url(
            "https://github.com/owner/repo/issues/123"
        ));
        assert!(!is_github_issue_url("https://github.com/owner/repo"));
        assert!(!is_github_issue_url(
            "https://github.com/owner/repo/pull/123"
        ));
    }

    #[test]
    fn test_parse_github_repo_url() {
        let info = parse_github_repo_url("https://github.com/elizaos/eliza").unwrap();
        assert_eq!(info.owner, "elizaos");
        assert_eq!(info.repo, "eliza");
        assert_eq!(info.full_name, "elizaos/eliza");
    }

    #[test]
    fn test_parse_github_issue_url() {
        let info = parse_github_issue_url("https://github.com/elizaos/eliza/issues/42").unwrap();
        assert_eq!(info.owner, "elizaos");
        assert_eq!(info.repo, "eliza");
        assert_eq!(info.issue_number, 42);
    }
}
