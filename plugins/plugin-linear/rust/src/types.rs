#![allow(missing_docs)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct LinearConfig {
    pub api_key: String,
    pub workspace_id: Option<String>,
    pub default_team_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceType {
    Issue,
    Project,
    Comment,
    Label,
    User,
    Team,
}

impl std::fmt::Display for ResourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResourceType::Issue => write!(f, "issue"),
            ResourceType::Project => write!(f, "project"),
            ResourceType::Comment => write!(f, "comment"),
            ResourceType::Label => write!(f, "label"),
            ResourceType::User => write!(f, "user"),
            ResourceType::Team => write!(f, "team"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub action: String,
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub details: serde_json::Value,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IssueInput {
    pub title: String,
    pub team_id: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub assignee_id: Option<String>,
    pub label_ids: Vec<String>,
    pub project_id: Option<String>,
    pub state_id: Option<String>,
    pub estimate: Option<i32>,
    pub due_date: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct CommentInput {
    pub body: String,
    pub issue_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct SearchFilters {
    pub state: Option<Vec<String>>,
    pub assignee: Option<Vec<String>>,
    pub label: Option<Vec<String>>,
    pub project: Option<String>,
    pub team: Option<String>,
    pub priority: Option<Vec<i32>>,
    pub query: Option<String>,
    pub limit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub key: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub state_type: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: i32,
    pub priority_label: Option<String>,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub due_date: Option<String>,
    pub estimate: Option<i32>,
    pub assignee: Option<User>,
    pub state: Option<WorkflowState>,
    pub team: Option<Team>,
    pub labels: Option<Labels>,
    pub project: Option<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Labels {
    pub nodes: Vec<Label>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub state: Option<String>,
    pub progress: Option<f64>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub url: Option<String>,
    pub lead: Option<User>,
    pub teams: Option<Teams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Teams {
    pub nodes: Vec<Team>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub text: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: None,
        }
    }

    pub fn success_with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: Some(data),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: false,
            data: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ProviderResult {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            data: None,
        }
    }

    pub fn with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            data: Some(data),
        }
    }
}
