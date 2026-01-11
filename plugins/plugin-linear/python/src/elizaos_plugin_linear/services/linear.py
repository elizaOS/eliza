"""Linear API service for ElizaOS."""

import uuid
from datetime import datetime
from typing import Protocol

import httpx

from elizaos_plugin_linear.types import (
    CommentData,
    IssueData,
    LabelData,
    LinearActivityItem,
    LinearAPIError,
    LinearAuthenticationError,
    LinearCommentInput,
    LinearConfig,
    LinearIssueInput,
    LinearSearchFilters,
    ProjectData,
    StateData,
    TeamData,
    UserData,
)


class RuntimeProtocol(Protocol):
    """Protocol for ElizaOS runtime."""
    
    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


# GraphQL queries
VIEWER_QUERY = """
query Viewer {
    viewer {
        id
        email
        name
    }
}
"""

TEAMS_QUERY = """
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
"""

TEAM_QUERY = """
query Team($id: String!) {
    team(id: $id) {
        id
        name
        key
        description
    }
}
"""

USERS_QUERY = """
query Users {
    users {
        nodes {
            id
            name
            email
        }
    }
}
"""

ISSUE_QUERY = """
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
"""

ISSUES_QUERY = """
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
"""

CREATE_ISSUE_MUTATION = """
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
"""

UPDATE_ISSUE_MUTATION = """
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
"""

ARCHIVE_ISSUE_MUTATION = """
mutation ArchiveIssue($id: String!) {
    issueArchive(id: $id) {
        success
    }
}
"""

CREATE_COMMENT_MUTATION = """
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
"""

PROJECTS_QUERY = """
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
"""

LABELS_QUERY = """
query Labels($first: Int, $filter: IssueLabelFilter) {
    issueLabels(first: $first, filter: $filter) {
        nodes {
            id
            name
            color
        }
    }
}
"""

WORKFLOW_STATES_QUERY = """
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
"""


class LinearService:
    """Service for interacting with the Linear API."""
    
    service_type = "linear"
    capability_description = (
        "Linear API integration for issue tracking, project management, and team collaboration"
    )
    
    def __init__(self, runtime: RuntimeProtocol) -> None:
        """Initialize the Linear service.
        
        Args:
            runtime: The ElizaOS runtime for accessing settings.
            
        Raises:
            LinearAuthenticationError: If no API key is provided.
        """
        api_key = runtime.get_setting("LINEAR_API_KEY")
        if not api_key:
            raise LinearAuthenticationError("Linear API key is required")
        
        workspace_id = runtime.get_setting("LINEAR_WORKSPACE_ID")
        default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")
        
        self.config = LinearConfig(
            api_key=api_key,
            workspace_id=workspace_id,
            default_team_key=default_team_key,
        )
        
        self._client = httpx.AsyncClient(
            base_url="https://api.linear.app/graphql",
            headers={
                "Authorization": api_key,
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )
        
        self._activity_log: list[LinearActivityItem] = []
    
    @classmethod
    async def start(cls, runtime: RuntimeProtocol) -> "LinearService":
        """Start the Linear service.
        
        Args:
            runtime: The ElizaOS runtime.
            
        Returns:
            An initialized LinearService instance.
        """
        service = cls(runtime)
        await service._validate_connection()
        return service
    
    async def stop(self) -> None:
        """Stop the service and clean up resources."""
        self._activity_log = []
        await self._client.aclose()
    
    async def _validate_connection(self) -> None:
        """Validate the API connection by fetching the current user."""
        try:
            await self.get_current_user()
        except Exception as e:
            raise LinearAuthenticationError(f"Failed to authenticate with Linear API: {e}")
    
    async def _execute_query(
        self,
        query: str,
        variables: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Execute a GraphQL query against the Linear API.
        
        Args:
            query: The GraphQL query string.
            variables: Optional query variables.
            
        Returns:
            The query response data.
            
        Raises:
            LinearAPIError: If the request fails.
        """
        payload: dict[str, object] = {"query": query}
        if variables:
            payload["variables"] = variables
        
        response = await self._client.post("", json=payload)
        
        if response.status_code == 401:
            raise LinearAuthenticationError("Invalid API key")
        if response.status_code == 429:
            raise LinearAPIError("Rate limit exceeded", status=429)
        if response.status_code >= 400:
            raise LinearAPIError(f"API error: {response.text}", status=response.status_code)
        
        data = response.json()
        if "errors" in data:
            error_msg = data["errors"][0].get("message", "Unknown error")
            raise LinearAPIError(f"GraphQL error: {error_msg}")
        
        return data.get("data", {})
    
    def _log_activity(
        self,
        action: str,
        resource_type: str,
        resource_id: str,
        details: dict[str, object],
        success: bool,
        error: str | None = None,
    ) -> None:
        """Log an activity item."""
        activity = LinearActivityItem(
            id=f"{int(datetime.now().timestamp() * 1000)}-{uuid.uuid4().hex[:9]}",
            timestamp=datetime.now().isoformat(),
            action=action,
            resource_type=resource_type,  # type: ignore
            resource_id=resource_id,
            details=details,
            success=success,
            error=error,
        )
        
        self._activity_log.append(activity)
        
        # Keep only last 1000 activities
        if len(self._activity_log) > 1000:
            self._activity_log = self._activity_log[-1000:]
    
    def get_activity_log(
        self,
        limit: int = 100,
        filter_by: dict[str, object] | None = None,
    ) -> list[LinearActivityItem]:
        """Get the activity log.
        
        Args:
            limit: Maximum number of items to return.
            filter_by: Optional filter criteria.
            
        Returns:
            List of activity items.
        """
        filtered = list(self._activity_log)
        
        if filter_by:
            for key, value in filter_by.items():
                filtered = [
                    item for item in filtered
                    if getattr(item, key, None) == value
                ]
        
        return filtered[-limit:]
    
    def clear_activity_log(self) -> None:
        """Clear the activity log."""
        self._activity_log = []
    
    # Team operations
    async def get_teams(self) -> list[TeamData]:
        """Get all teams.
        
        Returns:
            List of teams.
        """
        try:
            data = await self._execute_query(TEAMS_QUERY)
            teams = data.get("teams", {}).get("nodes", [])
            self._log_activity("list_teams", "team", "all", {"count": len(teams)}, True)
            return teams  # type: ignore
        except Exception as e:
            self._log_activity("list_teams", "team", "all", {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch teams: {e}")
    
    async def get_team(self, team_id: str) -> TeamData:
        """Get a specific team.
        
        Args:
            team_id: The team ID.
            
        Returns:
            Team data.
        """
        try:
            data = await self._execute_query(TEAM_QUERY, {"id": team_id})
            team = data.get("team", {})
            self._log_activity("get_team", "team", team_id, {"name": team.get("name")}, True)
            return team  # type: ignore
        except Exception as e:
            self._log_activity("get_team", "team", team_id, {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch team: {e}")
    
    # Issue operations
    async def create_issue(self, input_data: LinearIssueInput) -> IssueData:
        """Create a new issue.
        
        Args:
            input_data: The issue input data.
            
        Returns:
            The created issue.
        """
        try:
            variables = {
                "input": {
                    "title": input_data.title,
                    "teamId": input_data.team_id,
                }
            }
            
            if input_data.description:
                variables["input"]["description"] = input_data.description
            if input_data.priority is not None:
                variables["input"]["priority"] = input_data.priority
            if input_data.assignee_id:
                variables["input"]["assigneeId"] = input_data.assignee_id
            if input_data.label_ids:
                variables["input"]["labelIds"] = input_data.label_ids
            if input_data.project_id:
                variables["input"]["projectId"] = input_data.project_id
            if input_data.state_id:
                variables["input"]["stateId"] = input_data.state_id
            if input_data.estimate is not None:
                variables["input"]["estimate"] = input_data.estimate
            if input_data.due_date:
                variables["input"]["dueDate"] = input_data.due_date.isoformat()
            
            data = await self._execute_query(CREATE_ISSUE_MUTATION, variables)
            result = data.get("issueCreate", {})
            
            if not result.get("success"):
                raise LinearAPIError("Failed to create issue")
            
            issue = result.get("issue", {})
            self._log_activity(
                "create_issue", "issue", issue.get("id", "new"),
                {"title": input_data.title, "teamId": input_data.team_id},
                True
            )
            
            return issue  # type: ignore
        except Exception as e:
            self._log_activity(
                "create_issue", "issue", "new",
                {"title": input_data.title},
                False, str(e)
            )
            raise LinearAPIError(f"Failed to create issue: {e}")
    
    async def get_issue(self, issue_id: str) -> IssueData:
        """Get a specific issue.
        
        Args:
            issue_id: The issue ID or identifier (e.g., ENG-123).
            
        Returns:
            Issue data.
        """
        try:
            data = await self._execute_query(ISSUE_QUERY, {"id": issue_id})
            issue = data.get("issue", {})
            self._log_activity(
                "get_issue", "issue", issue_id,
                {"title": issue.get("title"), "identifier": issue.get("identifier")},
                True
            )
            return issue  # type: ignore
        except Exception as e:
            self._log_activity("get_issue", "issue", issue_id, {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch issue: {e}")
    
    async def update_issue(
        self,
        issue_id: str,
        updates: dict[str, object],
    ) -> IssueData:
        """Update an issue.
        
        Args:
            issue_id: The issue ID.
            updates: The fields to update.
            
        Returns:
            The updated issue.
        """
        try:
            variables = {"id": issue_id, "input": updates}
            data = await self._execute_query(UPDATE_ISSUE_MUTATION, variables)
            result = data.get("issueUpdate", {})
            
            if not result.get("success"):
                raise LinearAPIError("Failed to update issue")
            
            issue = result.get("issue", {})
            self._log_activity("update_issue", "issue", issue_id, updates, True)
            return issue  # type: ignore
        except Exception as e:
            self._log_activity("update_issue", "issue", issue_id, updates, False, str(e))
            raise LinearAPIError(f"Failed to update issue: {e}")
    
    async def delete_issue(self, issue_id: str) -> None:
        """Archive an issue (Linear doesn't support permanent deletion).
        
        Args:
            issue_id: The issue ID.
        """
        try:
            data = await self._execute_query(ARCHIVE_ISSUE_MUTATION, {"id": issue_id})
            result = data.get("issueArchive", {})
            
            if not result.get("success"):
                raise LinearAPIError("Failed to archive issue")
            
            self._log_activity(
                "delete_issue", "issue", issue_id,
                {"action": "archived"},
                True
            )
        except Exception as e:
            self._log_activity(
                "delete_issue", "issue", issue_id,
                {"action": "archive_failed"},
                False, str(e)
            )
            raise LinearAPIError(f"Failed to archive issue: {e}")
    
    async def search_issues(self, filters: LinearSearchFilters) -> list[IssueData]:
        """Search for issues.
        
        Args:
            filters: Search filters.
            
        Returns:
            List of matching issues.
        """
        try:
            filter_obj: dict[str, object] = {}
            
            if filters.query:
                filter_obj["or"] = [
                    {"title": {"containsIgnoreCase": filters.query}},
                    {"description": {"containsIgnoreCase": filters.query}},
                ]
            
            if filters.team:
                teams = await self.get_teams()
                team = next(
                    (t for t in teams 
                     if t["key"].lower() == filters.team.lower()
                     or t["name"].lower() == filters.team.lower()),
                    None
                )
                if team:
                    filter_obj["team"] = {"id": {"eq": team["id"]}}
            
            if filters.priority:
                filter_obj["priority"] = {"number": {"in": filters.priority}}
            
            if filters.state:
                filter_obj["state"] = {"name": {"in": filters.state}}
            
            variables = {
                "first": filters.limit or 50,
                "filter": filter_obj if filter_obj else None,
            }
            
            data = await self._execute_query(ISSUES_QUERY, variables)
            issues = data.get("issues", {}).get("nodes", [])
            
            self._log_activity(
                "search_issues", "issue", "search",
                {"filters": filters.__dict__, "count": len(issues)},
                True
            )
            
            return issues  # type: ignore
        except Exception as e:
            self._log_activity(
                "search_issues", "issue", "search",
                {"filters": filters.__dict__},
                False, str(e)
            )
            raise LinearAPIError(f"Failed to search issues: {e}")
    
    # Comment operations
    async def create_comment(self, input_data: LinearCommentInput) -> CommentData:
        """Create a comment on an issue.
        
        Args:
            input_data: The comment input data.
            
        Returns:
            The created comment.
        """
        try:
            variables = {
                "input": {
                    "body": input_data.body,
                    "issueId": input_data.issue_id,
                }
            }
            
            data = await self._execute_query(CREATE_COMMENT_MUTATION, variables)
            result = data.get("commentCreate", {})
            
            if not result.get("success"):
                raise LinearAPIError("Failed to create comment")
            
            comment = result.get("comment", {})
            self._log_activity(
                "create_comment", "comment", comment.get("id", "new"),
                {"issueId": input_data.issue_id, "bodyLength": len(input_data.body)},
                True
            )
            
            return comment  # type: ignore
        except Exception as e:
            self._log_activity(
                "create_comment", "comment", "new",
                {"issueId": input_data.issue_id},
                False, str(e)
            )
            raise LinearAPIError(f"Failed to create comment: {e}")
    
    # Project operations
    async def get_projects(self, team_id: str | None = None) -> list[ProjectData]:
        """Get projects.
        
        Args:
            team_id: Optional team ID to filter by.
            
        Returns:
            List of projects.
        """
        try:
            data = await self._execute_query(PROJECTS_QUERY, {"first": 100})
            projects = data.get("projects", {}).get("nodes", [])
            
            if team_id:
                projects = [
                    p for p in projects
                    if any(t["id"] == team_id for t in p.get("teams", {}).get("nodes", []))
                ]
            
            self._log_activity(
                "list_projects", "project", "all",
                {"count": len(projects), "teamId": team_id},
                True
            )
            
            return projects  # type: ignore
        except Exception as e:
            self._log_activity(
                "list_projects", "project", "all",
                {"teamId": team_id},
                False, str(e)
            )
            raise LinearAPIError(f"Failed to fetch projects: {e}")
    
    async def get_project(self, project_id: str) -> ProjectData:
        """Get a specific project.
        
        Args:
            project_id: The project ID.
            
        Returns:
            Project data.
        """
        try:
            projects = await self.get_projects()
            project = next((p for p in projects if p["id"] == project_id), None)
            
            if not project:
                raise LinearAPIError(f"Project {project_id} not found")
            
            self._log_activity(
                "get_project", "project", project_id,
                {"name": project["name"]},
                True
            )
            
            return project
        except Exception as e:
            self._log_activity("get_project", "project", project_id, {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch project: {e}")
    
    # User operations
    async def get_users(self) -> list[UserData]:
        """Get all users.
        
        Returns:
            List of users.
        """
        try:
            data = await self._execute_query(USERS_QUERY)
            users = data.get("users", {}).get("nodes", [])
            self._log_activity("list_users", "user", "all", {"count": len(users)}, True)
            return users  # type: ignore
        except Exception as e:
            self._log_activity("list_users", "user", "all", {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch users: {e}")
    
    async def get_current_user(self) -> UserData:
        """Get the current authenticated user.
        
        Returns:
            Current user data.
        """
        try:
            data = await self._execute_query(VIEWER_QUERY)
            user = data.get("viewer", {})
            self._log_activity(
                "get_current_user", "user", user.get("id", "current"),
                {"email": user.get("email"), "name": user.get("name")},
                True
            )
            return user  # type: ignore
        except Exception as e:
            self._log_activity("get_current_user", "user", "current", {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch current user: {e}")
    
    # Label operations
    async def get_labels(self, team_id: str | None = None) -> list[LabelData]:
        """Get issue labels.
        
        Args:
            team_id: Optional team ID to filter by.
            
        Returns:
            List of labels.
        """
        try:
            filter_obj = None
            if team_id:
                filter_obj = {"team": {"id": {"eq": team_id}}}
            
            data = await self._execute_query(LABELS_QUERY, {"first": 100, "filter": filter_obj})
            labels = data.get("issueLabels", {}).get("nodes", [])
            
            self._log_activity(
                "list_labels", "label", "all",
                {"count": len(labels), "teamId": team_id},
                True
            )
            
            return labels  # type: ignore
        except Exception as e:
            self._log_activity("list_labels", "label", "all", {"teamId": team_id}, False, str(e))
            raise LinearAPIError(f"Failed to fetch labels: {e}")
    
    # Workflow state operations
    async def get_workflow_states(self, team_id: str) -> list[StateData]:
        """Get workflow states for a team.
        
        Args:
            team_id: The team ID.
            
        Returns:
            List of workflow states.
        """
        try:
            data = await self._execute_query(
                WORKFLOW_STATES_QUERY,
                {"filter": {"team": {"id": {"eq": team_id}}}}
            )
            states = data.get("workflowStates", {}).get("nodes", [])
            
            self._log_activity(
                "list_workflow_states", "team", team_id,
                {"count": len(states)},
                True
            )
            
            return states  # type: ignore
        except Exception as e:
            self._log_activity("list_workflow_states", "team", team_id, {}, False, str(e))
            raise LinearAPIError(f"Failed to fetch workflow states: {e}")


