/**
 * Prompt templates for Linear plugin actions.
 *
 * Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const createCommentTemplate = `Extract comment details from the user's request to add a comment to a Linear issue.

User request: "{{userMessage}}"

The user might express this in various ways:
- "Comment on ENG-123: This looks good"
- "Tell ENG-123 that the fix is ready for testing"
- "Add a note to the login bug saying we need more info"
- "Reply to COM2-7: Thanks for the update"
- "Let the payment issue know that it's blocked by API changes"

Respond with JSON only. Use this shape:
{
  "issueId": "Direct issue ID if explicitly mentioned, for example ENG-123",
  "issueDescription": "Description or keywords of the issue if no ID was provided",
  "commentBody": "The actual comment content to add",
  "commentType": "note|reply|update|question|feedback"
}

Extract the core message the user wants to convey as the comment body.
Omit unknown fields. Output only the JSON object, with no prose before or after it.`;

export const CREATE_COMMENT_TEMPLATE = createCommentTemplate;

export const createIssueTemplate = `Given the user's request, extract the information needed to create a Linear issue.

User request: "{{userMessage}}"

Respond with JSON only. Use this shape:
{
  "title": "Brief, clear issue title",
  "description": "Detailed description of the issue",
  "teamKey": "Team key if mentioned, such as ENG or PROD",
  "priority": 3,
  "labels": ["label"],
  "assignee": "Assignee username or email if mentioned"
}

Omit optional fields when they are not provided. Output only the JSON object, with no prose before or after it.`;

export const CREATE_ISSUE_TEMPLATE = createIssueTemplate;

export const deleteIssueTemplate = `Given the user's request to delete/archive a Linear issue, extract the issue identifier.

User request: "{{userMessage}}"

Respond with JSON only:
{
  "issueId": "The issue identifier, such as ENG-123 or COM2-7"
}

Output only the JSON object, with no prose before or after it.`;

export const DELETE_ISSUE_TEMPLATE = deleteIssueTemplate;

export const getActivityTemplate = `Extract activity filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for activity in various ways:
- "Show me today's activity" → time range filter
- "What issues were created?" → action type filter
- "What did John do yesterday?" → user filter + time range
- "Activity on ENG-123" → resource filter
- "Recent comment activity" → action type + recency
- "Failed operations this week" → success filter + time range

Respond with JSON only. Use this shape:
{
  "timeRange": {
    "period": "today|yesterday|this-week|last-week|this-month",
    "from": "ISO datetime if a specific start is mentioned",
    "to": "ISO datetime if a specific end is mentioned"
  },
  "actionTypes": ["create_issue"],
  "resourceTypes": ["issue"],
  "resourceId": "Specific resource ID if mentioned, such as ENG-123",
  "user": "User name, or me for current user",
  "successFilter": "success|failed|all",
  "limit": 10
}

Only include fields that are clearly mentioned. Output only the JSON object, with no prose before or after it.`;

export const GET_ACTIVITY_TEMPLATE = getActivityTemplate;

export const getIssueTemplate = `Extract issue identification from the user's request.

User request: "{{userMessage}}"

The user might reference an issue by:
- Direct ID (e.g., "ENG-123", "COM2-7")
- Title keywords (e.g., "the login bug", "that payment issue")
- Assignee (e.g., "John's high priority task")
- Recency (e.g., "the latest bug", "most recent issue")
- Team context (e.g., "newest issue in ELIZA team")

Respond with JSON only. Use directId when an issue ID is explicitly mentioned:
{
  "directId": "Issue ID such as ENG-123"
}

When no issue ID is provided, use searchBy fields:
{
  "searchBy": {
    "title": "Keywords from issue title if mentioned",
    "assignee": "Name or email of assignee if mentioned",
    "priority": "urgent|high|normal|low|1|2|3|4",
    "team": "Team name or key if mentioned",
    "state": "Issue state if mentioned, such as todo, in-progress, or done",
    "recency": "latest|newest|recent|last",
    "type": "bug|feature|task"
  }
}

Only include fields that are clearly mentioned or implied. Output only the JSON object, with no prose before or after it.`;

export const GET_ISSUE_TEMPLATE = getIssueTemplate;

export const listProjectsTemplate = `Extract project filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for projects in various ways:
- "Show me all projects" → list all projects
- "Active projects" → filter by state (active/planned/completed)
- "Projects due this quarter" → filter by target date
- "Which projects is Sarah managing?" → filter by lead/owner
- "Projects with high priority issues" → filter by contained issue priority
- "Projects for the engineering team" → filter by team
- "Completed projects" → filter by state
- "Projects starting next month" → filter by start date

Respond with JSON only. Use this shape:
{
  "teamFilter": "Team name or key if mentioned",
  "stateFilter": "active|planned|completed|all",
  "dateFilter": {
    "type": "due|starting",
    "period": "this-week|this-month|this-quarter|next-month|next-quarter",
    "from": "ISO date if a specific start is mentioned",
    "to": "ISO date if a specific end is mentioned"
  },
  "leadFilter": "Project lead name if mentioned",
  "showAll": true
}

Only include fields that are clearly mentioned. Output only the JSON object, with no prose before or after it.`;

export const LIST_PROJECTS_TEMPLATE = listProjectsTemplate;

export const listTeamsTemplate = `Extract team filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for teams in various ways:
- "Show me all teams" → list all teams
- "Engineering teams" → filter by teams with engineering in name/description
- "List teams I'm part of" → filter by membership
- "Which teams work on the mobile app?" → filter by description/focus
- "Show me the ELIZA team details" → specific team lookup
- "Active teams" → teams with recent activity
- "Frontend and backend teams" → multiple team types

Respond with JSON only. Use this shape:
{
  "nameFilter": "Keywords to search in team names",
  "specificTeam": "Specific team name or key if looking for one team",
  "myTeams": true,
  "showAll": true,
  "includeDetails": true
}

Only include fields that are clearly mentioned. Output only the JSON object, with no prose before or after it.`;

export const LIST_TEAMS_TEMPLATE = listTeamsTemplate;

export const searchIssuesTemplate = `Extract search criteria from the user's request for Linear issues.

User request: "{{userMessage}}"

The user might express searches in various ways:
- "Show me what John is working on" → assignee filter
- "Any blockers for the next release?" → priority/label filters
- "Issues created this week" → date range filter
- "My high priority bugs" → assignee (current user) + priority + label
- "Unassigned tasks in the backend team" → no assignee + team filter
- "What did Sarah close yesterday?" → assignee + state + date
- "Bugs that are almost done" → label + state filter
- "Show me the oldest open issues" → state + sort order

Respond with JSON only. Use this shape:
{
  "query": "General search text for title or description",
  "states": ["In Progress"],
  "assignees": ["me"],
  "priorities": ["high"],
  "teams": ["ENG"],
  "labels": ["bug"],
  "hasAssignee": true,
  "dateRange": {
    "field": "created|updated|completed",
    "period": "today|yesterday|this-week|last-week|this-month|last-month",
    "from": "ISO date if a specific start is mentioned",
    "to": "ISO date if a specific end is mentioned"
  },
  "sort": {
    "field": "created|updated|priority",
    "order": "asc|desc"
  },
  "limit": 10
}

Only include fields that are clearly mentioned or implied. For "my" issues, set assignees to ["me"]. Output only the JSON object, with no prose before or after it.`;

export const SEARCH_ISSUES_TEMPLATE = searchIssuesTemplate;

export const updateIssueTemplate = `Given the user's request to update a Linear issue, extract the information needed.

User request: "{{userMessage}}"

Respond with JSON only. Use this shape:
{
  "issueId": "Issue identifier such as ENG-123 or COM2-7",
  "updates": {
    "title": "New title if changing the title",
    "description": "New description if changing the description",
    "priority": 3,
    "teamKey": "New team key if moving to another team, such as ENG, ELIZA, or COM2",
    "assignee": "New assignee username or email if changing",
    "status": "todo|in-progress|done|canceled",
    "labels": ["label"]
  }
}

Only include fields that are being updated. Use an empty labels array to clear all labels. Output only the JSON object, with no prose before or after it.`;

export const UPDATE_ISSUE_TEMPLATE = updateIssueTemplate;
