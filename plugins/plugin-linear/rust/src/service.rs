#![allow(missing_docs)]

use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::RwLock;
use tracing::info;
use uuid::Uuid;

use crate::error::{LinearError, Result};
use crate::types::*;

mod queries {
    pub const VIEWER: &str = r#"
        query Viewer {
            viewer {
                id
                email
                name
            }
        }
    "#;

    pub const TEAMS: &str = r#"
        query Teams {
            teams {
                nodes {
                    id
                    name
                    key
                    description
                }
            }
        }
    "#;

    pub const TEAM: &str = r#"
        query Team($id: String!) {
            team(id: $id) {
                id
                name
                key
                description
            }
        }
    "#;

    pub const USERS: &str = r#"
        query Users {
            users {
                nodes {
                    id
                    name
                    email
                }
            }
        }
    "#;

    pub const ISSUE: &str = r#"
        query Issue($id: String!) {
            issue(id: $id) {
                id
                identifier
                title
                description
                priority
                priorityLabel
                url
                createdAt
                updatedAt
                dueDate
                estimate
                assignee {
                    id
                    name
                    email
                }
                state {
                    id
                    name
                    type
                    color
                }
                team {
                    id
                    name
                    key
                }
                labels {
                    nodes {
                        id
                        name
                        color
                    }
                }
                project {
                    id
                    name
                    description
                }
            }
        }
    "#;

    pub const ISSUES: &str = r#"
        query Issues($first: Int, $filter: IssueFilter) {
            issues(first: $first, filter: $filter) {
                nodes {
                    id
                    identifier
                    title
                    description
                    priority
                    priorityLabel
                    url
                    createdAt
                    updatedAt
                    assignee {
                        id
                        name
                        email
                    }
                    state {
                        id
                        name
                        type
                    }
                    team {
                        id
                        name
                        key
                    }
                }
            }
        }
    "#;

    pub const CREATE_ISSUE: &str = r#"
        mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
                success
                issue {
                    id
                    identifier
                    title
                    url
                }
            }
        }
    "#;

    pub const UPDATE_ISSUE: &str = r#"
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
                success
                issue {
                    id
                    identifier
                    title
                    url
                }
            }
        }
    "#;

    pub const ARCHIVE_ISSUE: &str = r#"
        mutation ArchiveIssue($id: String!) {
            issueArchive(id: $id) {
                success
            }
        }
    "#;

    pub const CREATE_COMMENT: &str = r#"
        mutation CreateComment($input: CommentCreateInput!) {
            commentCreate(input: $input) {
                success
                comment {
                    id
                    body
                    createdAt
                }
            }
        }
    "#;

    pub const PROJECTS: &str = r#"
        query Projects($first: Int) {
            projects(first: $first) {
                nodes {
                    id
                    name
                    description
                    state
                    progress
                    startDate
                    targetDate
                    url
                    teams {
                        nodes {
                            id
                            name
                            key
                        }
                    }
                    lead {
                        id
                        name
                        email
                    }
                }
            }
        }
    "#;

    pub const LABELS: &str = r#"
        query Labels($first: Int, $filter: IssueLabelFilter) {
            issueLabels(first: $first, filter: $filter) {
                nodes {
                    id
                    name
                    color
                }
            }
        }
    "#;

    pub const WORKFLOW_STATES: &str = r#"
        query WorkflowStates($filter: WorkflowStateFilter) {
            workflowStates(filter: $filter) {
                nodes {
                    id
                    name
                    type
                    color
                }
            }
        }
    "#;
}

pub struct LinearService {
    config: LinearConfig,
    client: Client,
    activity_log: RwLock<Vec<ActivityItem>>,
}

impl LinearService {
    pub fn new(config: LinearConfig) -> Result<Self> {
        if config.api_key.is_empty() {
            return Err(LinearError::Authentication(
                "Linear API key is required".to_string(),
            ));
        }

        let client = Client::new();

        Ok(Self {
            config,
            client,
            activity_log: RwLock::new(Vec::new()),
        })
    }

    pub async fn start(config: LinearConfig) -> Result<Self> {
        let service = Self::new(config)?;
        service.validate_connection().await?;
        info!("Linear service started successfully");
        Ok(service)
    }

    async fn validate_connection(&self) -> Result<()> {
        self.get_current_user().await?;
        Ok(())
    }

    async fn execute_query(&self, query: &str, variables: Option<Value>) -> Result<Value> {
        let mut payload = json!({ "query": query });
        if let Some(vars) = variables {
            payload["variables"] = vars;
        }

        let response = self
            .client
            .post("https://api.linear.app/graphql")
            .header("Authorization", &self.config.api_key)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        let status = response.status();

        if status.as_u16() == 401 {
            return Err(LinearError::Authentication("Invalid API key".to_string()));
        }
        if status.as_u16() == 429 {
            return Err(LinearError::RateLimit { reset_time: 60 });
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(LinearError::Api {
                status: status.as_u16(),
                message: text,
            });
        }

        let data: Value = response.json().await?;

        if let Some(errors) = data.get("errors") {
            if let Some(error) = errors.as_array().and_then(|e| e.first()) {
                let msg = error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(LinearError::GraphQL(msg.to_string()));
            }
        }

        Ok(data.get("data").cloned().unwrap_or(json!({})))
    }

    fn log_activity(
        &self,
        action: &str,
        resource_type: ResourceType,
        resource_id: &str,
        details: Value,
        success: bool,
        error: Option<String>,
    ) {
        let activity = ActivityItem {
            id: format!("{}-{}", Utc::now().timestamp_millis(), Uuid::new_v4()),
            timestamp: Utc::now(),
            action: action.to_string(),
            resource_type,
            resource_id: resource_id.to_string(),
            details,
            success,
            error,
        };

        if let Ok(mut log) = self.activity_log.write() {
            log.push(activity);
            let len = log.len();
            if len > 1000 {
                log.drain(0..len - 1000);
            }
        }
    }

    pub fn get_activity_log(&self, limit: Option<usize>) -> Vec<ActivityItem> {
        if let Ok(log) = self.activity_log.read() {
            let limit = limit.unwrap_or(100);
            log.iter().rev().take(limit).cloned().collect()
        } else {
            Vec::new()
        }
    }

    pub fn clear_activity_log(&self) {
        if let Ok(mut log) = self.activity_log.write() {
            log.clear();
            info!("Linear activity log cleared");
        }
    }

    pub async fn get_teams(&self) -> Result<Vec<Team>> {
        match self.execute_query(queries::TEAMS, None).await {
            Ok(data) => {
                let teams: Vec<Team> = serde_json::from_value(
                    data.get("teams")
                        .and_then(|t| t.get("nodes"))
                        .cloned()
                        .unwrap_or(json!([])),
                )?;
                self.log_activity(
                    "list_teams",
                    ResourceType::Team,
                    "all",
                    json!({ "count": teams.len() }),
                    true,
                    None,
                );
                Ok(teams)
            }
            Err(e) => {
                self.log_activity(
                    "list_teams",
                    ResourceType::Team,
                    "all",
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_team(&self, team_id: &str) -> Result<Team> {
        let variables = json!({ "id": team_id });

        match self.execute_query(queries::TEAM, Some(variables)).await {
            Ok(data) => {
                let team: Team =
                    serde_json::from_value(data.get("team").cloned().ok_or_else(|| {
                        LinearError::NotFound(format!("Team {} not found", team_id))
                    })?)?;

                self.log_activity(
                    "get_team",
                    ResourceType::Team,
                    team_id,
                    json!({ "name": team.name }),
                    true,
                    None,
                );

                Ok(team)
            }
            Err(e) => {
                self.log_activity(
                    "get_team",
                    ResourceType::Team,
                    team_id,
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn create_issue(&self, input: IssueInput) -> Result<Issue> {
        let mut issue_input = json!({
            "title": input.title,
            "teamId": input.team_id,
        });

        if let Some(desc) = &input.description {
            issue_input["description"] = json!(desc);
        }
        if let Some(priority) = input.priority {
            issue_input["priority"] = json!(priority);
        }
        if let Some(assignee_id) = &input.assignee_id {
            issue_input["assigneeId"] = json!(assignee_id);
        }
        if !input.label_ids.is_empty() {
            issue_input["labelIds"] = json!(input.label_ids);
        }
        if let Some(project_id) = &input.project_id {
            issue_input["projectId"] = json!(project_id);
        }
        if let Some(state_id) = &input.state_id {
            issue_input["stateId"] = json!(state_id);
        }

        let variables = json!({ "input": issue_input });

        match self
            .execute_query(queries::CREATE_ISSUE, Some(variables))
            .await
        {
            Ok(data) => {
                let result = data.get("issueCreate").ok_or_else(|| LinearError::Api {
                    status: 500,
                    message: "No issueCreate in response".to_string(),
                })?;

                if !result
                    .get("success")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false)
                {
                    return Err(LinearError::Api {
                        status: 400,
                        message: "Failed to create issue".to_string(),
                    });
                }

                let issue: Issue =
                    serde_json::from_value(result.get("issue").cloned().unwrap_or(json!({})))?;

                self.log_activity(
                    "create_issue",
                    ResourceType::Issue,
                    &issue.id,
                    json!({ "title": input.title, "teamId": input.team_id }),
                    true,
                    None,
                );

                Ok(issue)
            }
            Err(e) => {
                self.log_activity(
                    "create_issue",
                    ResourceType::Issue,
                    "new",
                    json!({ "title": input.title }),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_issue(&self, issue_id: &str) -> Result<Issue> {
        let variables = json!({ "id": issue_id });

        match self.execute_query(queries::ISSUE, Some(variables)).await {
            Ok(data) => {
                let issue: Issue =
                    serde_json::from_value(data.get("issue").cloned().ok_or_else(|| {
                        LinearError::NotFound(format!("Issue {} not found", issue_id))
                    })?)?;

                self.log_activity(
                    "get_issue",
                    ResourceType::Issue,
                    issue_id,
                    json!({ "title": issue.title, "identifier": issue.identifier }),
                    true,
                    None,
                );

                Ok(issue)
            }
            Err(e) => {
                self.log_activity(
                    "get_issue",
                    ResourceType::Issue,
                    issue_id,
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn update_issue(&self, issue_id: &str, updates: Value) -> Result<Issue> {
        let variables = json!({
            "id": issue_id,
            "input": updates,
        });

        match self
            .execute_query(queries::UPDATE_ISSUE, Some(variables))
            .await
        {
            Ok(data) => {
                let result = data.get("issueUpdate").ok_or_else(|| LinearError::Api {
                    status: 500,
                    message: "No issueUpdate in response".to_string(),
                })?;

                if !result
                    .get("success")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false)
                {
                    return Err(LinearError::Api {
                        status: 400,
                        message: "Failed to update issue".to_string(),
                    });
                }

                let issue: Issue =
                    serde_json::from_value(result.get("issue").cloned().unwrap_or(json!({})))?;

                self.log_activity(
                    "update_issue",
                    ResourceType::Issue,
                    issue_id,
                    updates.clone(),
                    true,
                    None,
                );

                Ok(issue)
            }
            Err(e) => {
                self.log_activity(
                    "update_issue",
                    ResourceType::Issue,
                    issue_id,
                    updates,
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn delete_issue(&self, issue_id: &str) -> Result<()> {
        let variables = json!({ "id": issue_id });

        match self
            .execute_query(queries::ARCHIVE_ISSUE, Some(variables))
            .await
        {
            Ok(data) => {
                let result = data.get("issueArchive").ok_or_else(|| LinearError::Api {
                    status: 500,
                    message: "No issueArchive in response".to_string(),
                })?;

                if !result
                    .get("success")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false)
                {
                    return Err(LinearError::Api {
                        status: 400,
                        message: "Failed to archive issue".to_string(),
                    });
                }

                self.log_activity(
                    "delete_issue",
                    ResourceType::Issue,
                    issue_id,
                    json!({ "action": "archived" }),
                    true,
                    None,
                );

                Ok(())
            }
            Err(e) => {
                self.log_activity(
                    "delete_issue",
                    ResourceType::Issue,
                    issue_id,
                    json!({ "action": "archive_failed" }),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn search_issues(&self, filters: SearchFilters) -> Result<Vec<Issue>> {
        let mut filter_obj = json!({});

        if let Some(query) = &filters.query {
            filter_obj["or"] = json!([
                { "title": { "containsIgnoreCase": query } },
                { "description": { "containsIgnoreCase": query } },
            ]);
        }

        if let Some(team) = &filters.team {
            let teams = self.get_teams().await?;
            if let Some(found_team) = teams
                .iter()
                .find(|t| t.key.eq_ignore_ascii_case(team) || t.name.eq_ignore_ascii_case(team))
            {
                filter_obj["team"] = json!({ "id": { "eq": found_team.id } });
            }
        }

        if let Some(priorities) = &filters.priority {
            filter_obj["priority"] = json!({ "number": { "in": priorities } });
        }

        if let Some(states) = &filters.state {
            filter_obj["state"] = json!({ "name": { "in": states } });
        }

        let variables = json!({
            "first": filters.limit.unwrap_or(50),
            "filter": if filter_obj.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                Value::Null
            } else {
                filter_obj
            },
        });

        match self.execute_query(queries::ISSUES, Some(variables)).await {
            Ok(data) => {
                let issues: Vec<Issue> = serde_json::from_value(
                    data.get("issues")
                        .and_then(|i| i.get("nodes"))
                        .cloned()
                        .unwrap_or(json!([])),
                )?;

                self.log_activity(
                    "search_issues",
                    ResourceType::Issue,
                    "search",
                    json!({ "count": issues.len() }),
                    true,
                    None,
                );

                Ok(issues)
            }
            Err(e) => {
                self.log_activity(
                    "search_issues",
                    ResourceType::Issue,
                    "search",
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn create_comment(&self, input: CommentInput) -> Result<Comment> {
        let variables = json!({
            "input": {
                "body": input.body,
                "issueId": input.issue_id,
            }
        });

        match self
            .execute_query(queries::CREATE_COMMENT, Some(variables))
            .await
        {
            Ok(data) => {
                let result = data.get("commentCreate").ok_or_else(|| LinearError::Api {
                    status: 500,
                    message: "No commentCreate in response".to_string(),
                })?;

                if !result
                    .get("success")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false)
                {
                    return Err(LinearError::Api {
                        status: 400,
                        message: "Failed to create comment".to_string(),
                    });
                }

                let comment: Comment =
                    serde_json::from_value(result.get("comment").cloned().unwrap_or(json!({})))?;

                self.log_activity(
                    "create_comment",
                    ResourceType::Comment,
                    &comment.id,
                    json!({ "issueId": input.issue_id, "bodyLength": input.body.len() }),
                    true,
                    None,
                );

                Ok(comment)
            }
            Err(e) => {
                self.log_activity(
                    "create_comment",
                    ResourceType::Comment,
                    "new",
                    json!({ "issueId": input.issue_id }),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_projects(&self, team_id: Option<&str>) -> Result<Vec<Project>> {
        let variables = json!({ "first": 100 });

        match self.execute_query(queries::PROJECTS, Some(variables)).await {
            Ok(data) => {
                let mut projects: Vec<Project> = serde_json::from_value(
                    data.get("projects")
                        .and_then(|p| p.get("nodes"))
                        .cloned()
                        .unwrap_or(json!([])),
                )?;

                if let Some(tid) = team_id {
                    projects.retain(|p| {
                        p.teams
                            .as_ref()
                            .map(|teams| teams.nodes.iter().any(|t| t.id == tid))
                            .unwrap_or(false)
                    });
                }

                self.log_activity(
                    "list_projects",
                    ResourceType::Project,
                    "all",
                    json!({ "count": projects.len(), "teamId": team_id }),
                    true,
                    None,
                );

                Ok(projects)
            }
            Err(e) => {
                self.log_activity(
                    "list_projects",
                    ResourceType::Project,
                    "all",
                    json!({ "teamId": team_id }),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_project(&self, project_id: &str) -> Result<Project> {
        let projects = self.get_projects(None).await?;

        let project = projects
            .into_iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| LinearError::NotFound(format!("Project {} not found", project_id)))?;

        self.log_activity(
            "get_project",
            ResourceType::Project,
            project_id,
            json!({ "name": project.name }),
            true,
            None,
        );

        Ok(project)
    }

    pub async fn get_users(&self) -> Result<Vec<User>> {
        match self.execute_query(queries::USERS, None).await {
            Ok(data) => {
                let users: Vec<User> = serde_json::from_value(
                    data.get("users")
                        .and_then(|u| u.get("nodes"))
                        .cloned()
                        .unwrap_or(json!([])),
                )?;

                self.log_activity(
                    "list_users",
                    ResourceType::User,
                    "all",
                    json!({ "count": users.len() }),
                    true,
                    None,
                );

                Ok(users)
            }
            Err(e) => {
                self.log_activity(
                    "list_users",
                    ResourceType::User,
                    "all",
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_current_user(&self) -> Result<User> {
        match self.execute_query(queries::VIEWER, None).await {
            Ok(data) => {
                let user: User =
                    serde_json::from_value(data.get("viewer").cloned().ok_or_else(|| {
                        LinearError::Authentication("Failed to get current user".to_string())
                    })?)?;

                self.log_activity(
                    "get_current_user",
                    ResourceType::User,
                    &user.id,
                    json!({ "email": user.email, "name": user.name }),
                    true,
                    None,
                );

                Ok(user)
            }
            Err(e) => {
                self.log_activity(
                    "get_current_user",
                    ResourceType::User,
                    "current",
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_labels(&self, team_id: Option<&str>) -> Result<Vec<Label>> {
        let filter = team_id.map(|id| json!({ "team": { "id": { "eq": id } } }));
        let variables = json!({
            "first": 100,
            "filter": filter,
        });

        match self.execute_query(queries::LABELS, Some(variables)).await {
            Ok(data) => {
                let labels: Vec<Label> = serde_json::from_value(
                    data.get("issueLabels")
                        .and_then(|l| l.get("nodes"))
                        .cloned()
                        .unwrap_or(json!([])),
                )?;

                self.log_activity(
                    "list_labels",
                    ResourceType::Label,
                    "all",
                    json!({ "count": labels.len(), "teamId": team_id }),
                    true,
                    None,
                );

                Ok(labels)
            }
            Err(e) => {
                self.log_activity(
                    "list_labels",
                    ResourceType::Label,
                    "all",
                    json!({ "teamId": team_id }),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }

    pub async fn get_workflow_states(&self, team_id: &str) -> Result<Vec<WorkflowState>> {
        let variables = json!({
            "filter": {
                "team": { "id": { "eq": team_id } }
            }
        });

        match self
            .execute_query(queries::WORKFLOW_STATES, Some(variables))
            .await
        {
            Ok(data) => {
                let states: Vec<WorkflowState> = serde_json::from_value(
                    data.get("workflowStates")
                        .and_then(|s| s.get("nodes"))
                        .cloned()
                        .unwrap_or(json!([])),
                )?;

                self.log_activity(
                    "list_workflow_states",
                    ResourceType::Team,
                    team_id,
                    json!({ "count": states.len() }),
                    true,
                    None,
                );

                Ok(states)
            }
            Err(e) => {
                self.log_activity(
                    "list_workflow_states",
                    ResourceType::Team,
                    team_id,
                    json!({}),
                    false,
                    Some(e.to_string()),
                );
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_without_api_key() {
        let config = LinearConfig {
            api_key: String::new(),
            workspace_id: None,
            default_team_key: None,
        };

        let result = LinearService::new(config);
        assert!(result.is_err());
    }

    #[test]
    fn test_new_with_api_key() {
        let config = LinearConfig {
            api_key: "test-key".to_string(),
            workspace_id: None,
            default_team_key: None,
        };

        let result = LinearService::new(config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_activity_log() {
        let config = LinearConfig {
            api_key: "test-key".to_string(),
            workspace_id: None,
            default_team_key: None,
        };

        let service = LinearService::new(config).unwrap();

        service.clear_activity_log();
        assert!(service.get_activity_log(None).is_empty());

        service.log_activity(
            "test_action",
            ResourceType::Issue,
            "test-123",
            json!({ "test": "data" }),
            true,
            None,
        );

        let activity = service.get_activity_log(None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "test_action");
        assert!(activity[0].success);

        service.clear_activity_log();
        assert!(service.get_activity_log(None).is_empty());
    }
}
