"""
Auto-generated prompt templates
DO NOT EDIT - Generated from ../../../prompts/*.txt

These prompts use Handlebars-style template syntax:
- {{variableName}} for simple substitution
- {{#each items}}...{{/each}} for iteration
- {{#if condition}}...{{/if}} for conditionals
"""

from __future__ import annotations

CREATE_COMMENT_TEMPLATE = """Extract comment details from the user's request to add a comment to a Linear issue.

User request: "{{userMessage}}"

The user might express this in various ways:
- "Comment on ENG-123: This looks good"
- "Tell ENG-123 that the fix is ready for testing"
- "Add a note to the login bug saying we need more info"
- "Reply to COM2-7: Thanks for the update"
- "Let the payment issue know that it's blocked by API changes"

Return ONLY a JSON object:
{
  "issueId": "Direct issue ID if explicitly mentioned (e.g., ENG-123)",
  "issueDescription": "Description/keywords of the issue if no ID provided",
  "commentBody": "The actual comment content to add",
  "commentType": "note/reply/update/question/feedback (inferred from context)"
}

Extract the core message the user wants to convey as the comment body."""

CREATE_ISSUE_TEMPLATE = """Given the user's request, extract the information needed to create a Linear issue.

User request: "{{userMessage}}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with the following structure:
{
  "title": "Brief, clear issue title",
  "description": "Detailed description of the issue (optional, omit or use null if not provided)",
  "teamKey": "Team key if mentioned (e.g., ENG, PROD) - omit or use null if not mentioned",
  "priority": "Priority level if mentioned (1=urgent, 2=high, 3=normal, 4=low) - omit or use null if not mentioned",
  "labels": ["label1", "label2"] (if any labels are mentioned, empty array if none),
  "assignee": "Assignee username or email if mentioned - omit or use null if not mentioned"
}

Return only the JSON object, no other text."""

DELETE_ISSUE_TEMPLATE = """Given the user's request to delete/archive a Linear issue, extract the issue identifier.

User request: "{{userMessage}}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with:
{
  "issueId": "The issue identifier (e.g., ENG-123, COM2-7)"
}

Return only the JSON object, no other text."""

GET_ACTIVITY_TEMPLATE = """Extract activity filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for activity in various ways:
- "Show me today's activity" → time range filter
- "What issues were created?" → action type filter
- "What did John do yesterday?" → user filter + time range
- "Activity on ENG-123" → resource filter
- "Recent comment activity" → action type + recency
- "Failed operations this week" → success filter + time range

Return ONLY a JSON object:
{
  "timeRange": {
    "period": "today/yesterday/this-week/last-week/this-month",
    "from": "ISO datetime if specific",
    "to": "ISO datetime if specific"
  },
  "actionTypes": ["create_issue/update_issue/delete_issue/create_comment/search_issues/etc"],
  "resourceTypes": ["issue/project/comment/team"],
  "resourceId": "Specific resource ID if mentioned (e.g., ENG-123)",
  "user": "User name or 'me' for current user",
  "successFilter": "success/failed/all",
  "limit": number (default 10)
}

Only include fields that are clearly mentioned."""

GET_ISSUE_TEMPLATE = """Extract issue identification from the user's request.

User request: "{{userMessage}}"

The user might reference an issue by:
- Direct ID (e.g., "ENG-123", "COM2-7")
- Title keywords (e.g., "the login bug", "that payment issue")
- Assignee (e.g., "John's high priority task")
- Recency (e.g., "the latest bug", "most recent issue")
- Team context (e.g., "newest issue in ELIZA team")

Return ONLY a JSON object:
{
  "directId": "Issue ID if explicitly mentioned (e.g., ENG-123)",
  "searchBy": {
    "title": "Keywords from issue title if mentioned",
    "assignee": "Name/email of assignee if mentioned",
    "priority": "Priority level if mentioned (urgent/high/normal/low or 1-4)",
    "team": "Team name or key if mentioned",
    "state": "Issue state if mentioned (todo/in-progress/done)",
    "recency": "latest/newest/recent/last if mentioned",
    "type": "bug/feature/task if mentioned"
  }
}

Only include fields that are clearly mentioned or implied."""

LIST_PROJECTS_TEMPLATE = """Extract project filter criteria from the user's request.

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

Return ONLY a JSON object:
{
  "teamFilter": "Team name or key if mentioned",
  "stateFilter": "active/planned/completed/all",
  "dateFilter": {
    "type": "due/starting",
    "period": "this-week/this-month/this-quarter/next-month/next-quarter",
    "from": "ISO date if specific",
    "to": "ISO date if specific"
  },
  "leadFilter": "Project lead name if mentioned",
  "showAll": true/false (true if user explicitly asks for "all")
}

Only include fields that are clearly mentioned."""

LIST_TEAMS_TEMPLATE = """Extract team filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for teams in various ways:
- "Show me all teams" → list all teams
- "Engineering teams" → filter by teams with engineering in name/description
- "List teams I'm part of" → filter by membership
- "Which teams work on the mobile app?" → filter by description/focus
- "Show me the ELIZA team details" → specific team lookup
- "Active teams" → teams with recent activity
- "Frontend and backend teams" → multiple team types

Return ONLY a JSON object:
{
  "nameFilter": "Keywords to search in team names",
  "specificTeam": "Specific team name or key if looking for one team",
  "myTeams": true/false (true if user wants their teams),
  "showAll": true/false (true if user explicitly asks for "all"),
  "includeDetails": true/false (true if user wants detailed info)
}

Only include fields that are clearly mentioned."""

SEARCH_ISSUES_TEMPLATE = """Extract search criteria from the user's request for Linear issues.

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

Extract and return ONLY a JSON object:
{
  "query": "General search text for title/description",
  "states": ["state names like In Progress, Done, Todo, Backlog"],
  "assignees": ["assignee names or emails, or 'me' for current user"],
  "priorities": ["urgent/high/normal/low or 1/2/3/4"],
  "teams": ["team names or keys"],
  "labels": ["label names"],
  "hasAssignee": true/false (true = has assignee, false = unassigned),
  "dateRange": {
    "field": "created/updated/completed",
    "period": "today/yesterday/this-week/last-week/this-month/last-month",
    "from": "ISO date if specific date",
    "to": "ISO date if specific date"
  },
  "sort": {
    "field": "created/updated/priority",
    "order": "asc/desc"
  },
  "limit": number (default 10)
}

Only include fields that are clearly mentioned or implied. For "my" issues, set assignees to ["me"]."""

UPDATE_ISSUE_TEMPLATE = """Given the user's request to update a Linear issue, extract the information needed.

User request: "{{userMessage}}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with the following structure:
{
  "issueId": "The issue identifier (e.g., ENG-123, COM2-7)",
  "updates": {
    "title": "New title if changing the title",
    "description": "New description if changing the description",
    "priority": "Priority level if changing (1=urgent, 2=high, 3=normal, 4=low)",
    "teamKey": "New team key if moving to another team (e.g., ENG, ELIZA, COM2)",
    "assignee": "New assignee username or email if changing",
    "status": "New status if changing (e.g., todo, in-progress, done, canceled)",
    "labels": ["label1", "label2"] (if changing labels, empty array to clear)
  }
}

Only include fields that are being updated. Return only the JSON object, no other text."""

__all__ = [
    "CREATE_COMMENT_TEMPLATE",
    "CREATE_ISSUE_TEMPLATE",
    "DELETE_ISSUE_TEMPLATE",
    "GET_ACTIVITY_TEMPLATE",
    "GET_ISSUE_TEMPLATE",
    "LIST_PROJECTS_TEMPLATE",
    "LIST_TEAMS_TEMPLATE",
    "SEARCH_ISSUES_TEMPLATE",
    "UPDATE_ISSUE_TEMPLATE",
]
