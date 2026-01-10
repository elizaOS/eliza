# @elizaos/plugin-linear

A comprehensive Linear integration plugin for ElizaOS that enables issue tracking, project management, and team collaboration through the Linear API.

## Features

### 🤖 Natural Language Understanding
All actions now support advanced natural language parsing powered by LLM:
- **Flexible References**: Reference issues by ID, title keywords, assignee, or recency
- **Smart Filtering**: Use natural language for complex searches and filters
- **Context Awareness**: Understands relative references like "my issues" or "today's activity"
- **Graceful Fallbacks**: Falls back to pattern matching when LLM parsing fails

## Core Features

### 📋 Issue Management
- **Create Issues**: Create new issues with title, description, priority, assignees, and labels
- **Get Issue Details**: Retrieve comprehensive information about specific issues
- **Update Issues**: Modify existing issues with new information
- **Delete Issues**: Archive issues (move to archived state)
- **Search Issues**: Find issues using various filters and search criteria
- **Add Comments**: Comment on existing issues

### 👥 Team & User Management
- **List Teams**: View all teams in your Linear workspace
- **Get Team Details**: Retrieve specific team information
- **List Users**: View all users in the workspace
- **Get Current User**: Retrieve information about the authenticated user

### 📊 Project Management
- **List Projects**: View all projects, optionally filtered by team
- **Get Project Details**: Retrieve specific project information
- **Project Status**: Track project states and timelines

### 📈 Activity Tracking
- **Activity Log**: Track all Linear operations performed by the agent
- **Clear Activity**: Reset the activity log
- **Success/Error Tracking**: Monitor operation success rates

## Installation

```bash
npm install @elizaos/plugin-linear
```

## Configuration

The plugin requires a Linear API key for authentication. You can obtain one from your [Linear settings](https://linear.app/settings/api).

### Environment Variables

Create a `.env` file in your project root:

```env
# Required
LINEAR_API_KEY=your_linear_api_key_here

# Optional
LINEAR_WORKSPACE_ID=your_workspace_id_here
LINEAR_DEFAULT_TEAM_KEY=your_default_team_key_here  # e.g., ENG, ELIZA, COM2
```

### Default Team Behavior

When `LINEAR_DEFAULT_TEAM_KEY` is configured, it affects the following actions:

- **Create Issue**: New issues will be assigned to the default team if no team is specified
- **Search Issues**: Searches will be filtered by the default team unless:
  - A team filter is explicitly provided
  - The user asks for "all" issues
- **List Projects**: Projects will be filtered by the default team unless:
  - A specific team is mentioned
  - The user asks for "all" projects

This helps ensure that actions are scoped to the most relevant team by default while still allowing users to access all data when needed.

## Usage

### Register the Plugin

```typescript
import { linearPlugin } from '@elizaos/plugin-linear';

// Register with your ElizaOS agent
agent.registerPlugin(linearPlugin);
```

### Available Actions

#### Create Issue
```typescript
// Natural language
"Create a new issue: Fix login button not working on mobile devices"

// With options
{
  action: "CREATE_LINEAR_ISSUE",
  options: {
    title: "Fix login button",
    description: "The login button is not responsive on mobile devices",
    teamId: "team-123",
    priority: 2, // High
    assigneeId: "user-456"
  }
}
```

#### Get Issue
```typescript
// Natural language examples
"Show me issue ENG-123"  // Direct ID
"What's the status of the login bug?"  // Search by title
"Show me the latest high priority issue assigned to Sarah"  // Complex query
"Get John's most recent task"  // Assignee + recency

// With options
{
  action: "GET_LINEAR_ISSUE",
  options: {
    issueId: "issue-id-or-identifier"
  }
}
```

#### Search Issues
```typescript
// Natural language
"Show me all high priority bugs assigned to me"  // Uses default team if configured
"Show me all issues across all teams"  // Searches all teams
"Show me issues in the ELIZA team"  // Searches specific team

// With options
{
  action: "SEARCH_LINEAR_ISSUES",
  options: {
    query: "bug",
    priority: [1, 2], // Urgent and High
    state: ["in-progress", "todo"],
    team: "ELIZA",  // Override default team
    limit: 20
  }
}
```

#### Update Issue
```typescript
// Natural language examples
"Update issue ENG-123 title to 'Fix login button on all devices'"
"Move issue COM2-7 to the ELIZA team"
"Change the priority of BUG-456 to high and assign to john@example.com"
"Update issue PROD-789 status to in-progress"

// With options
{
  action: "UPDATE_LINEAR_ISSUE",
  options: {
    issueId: "issue-id",
    title: "Updated title",
    description: "Updated description",
    priority: 1,  // 1=urgent, 2=high, 3=normal, 4=low
    teamId: "team-id",  // Move to different team
    assigneeId: "user-id",
    stateId: "state-id",
    labelIds: ["label-id-1", "label-id-2"]
  }
}
```

#### Delete Issue
```typescript
// Natural language
"Delete issue ENG-123"
"Remove COM2-7 from Linear"
"Archive the bug report BUG-456"

// With options
{
  action: "DELETE_LINEAR_ISSUE",
  options: {
    issueId: "issue-id-or-identifier"
  }
}
```

> **Note**: Linear doesn't support permanent deletion. This action archives the issue, moving it to an archived state where it won't appear in active views.

#### Add Comment
```typescript
// Natural language examples
"Comment on ENG-123: This has been fixed in the latest release"
"Tell the login bug that we need more information from QA"
"Reply to COM2-7: Thanks for the update"
"Add a note to the payment issue saying it's blocked by API changes"

// With options
{
  action: "CREATE_LINEAR_COMMENT",
  options: {
    issueId: "issue-id",
    body: "This has been fixed in the latest release"
  }
}
```

#### List Teams
```typescript
// Natural language examples
"Show me all teams"  // Lists all teams
"Which engineering teams do we have?"  // Filter by name
"Show me the teams I'm part of"  // Personal teams
"Show me the ELIZA team details"  // Specific team lookup
```

#### List Projects
```typescript
// Natural language
"Show me all projects"  // Uses default team filter if configured
"Show me all projects across all teams"  // Lists all projects
"Show me projects for the engineering team"  // Lists projects for specific team

// With options
{
  action: "LIST_LINEAR_PROJECTS",
  options: {
    teamId: "team-id"
  }
}
```

#### Get Activity
```typescript
// Natural language examples
"Show me recent Linear activity"  // All recent activity
"What happened in Linear today?"  // Time-based filter
"Show me what issues John created this week"  // User + action + time
"Activity on ENG-123"  // Resource-specific activity
"Show me failed operations"  // Filter by success status

// With options
{
  action: "GET_LINEAR_ACTIVITY",
  options: {
    limit: 50,
    filter: { resource_type: "issue" }
  }
}
```

### Providers

The plugin includes several context providers that supply Linear data to the agent:

#### LINEAR_ISSUES
Provides context about recent Linear issues:
```typescript
"Recent Linear Issues:
- ENG-123: Fix login button (In Progress, John Doe)
- BUG-456: Memory leak in dashboard (Todo, Unassigned)
..."
```

#### LINEAR_TEAMS
Provides context about Linear teams:
```typescript
"Linear Teams:
- Engineering (ENG): Core development team
- Design (DES): Product design team
..."
```

#### LINEAR_PROJECTS
Provides context about active Linear projects:
```typescript
"Active Linear Projects:
- Q1 2024 Roadmap: started (Jan 1 - Mar 31)
- Mobile App Redesign: planned (Feb 1 - Apr 30)
..."
```

#### LINEAR_ACTIVITY
Provides context about recent Linear activity:
```typescript
"Recent Linear Activity:
✓ 2:30 PM: create_issue issue ENG-789
✗ 2:25 PM: update_issue issue BUG-456
..."
```

## Service API

The plugin exposes a `LinearService` that can be accessed programmatically:

```typescript
const linearService = runtime.getService<LinearService>('linear');

// Create an issue
const issue = await linearService.createIssue({
  title: "New feature request",
  description: "Detailed description",
  teamId: "team-123",
  priority: 3
});

// Search issues
const issues = await linearService.searchIssues({
  query: "authentication",
  state: ["todo", "in-progress"],
  limit: 10
});

// Get teams
const teams = await linearService.getTeams();

// Activity tracking
const recentActivity = linearService.getActivityLog(50);
```

## Error Handling

The plugin includes custom error classes for better error handling:

- `LinearAPIError`: General API errors
- `LinearAuthenticationError`: Authentication failures
- `LinearRateLimitError`: Rate limit exceeded

```typescript
try {
  await linearService.createIssue(issueData);
} catch (error) {
  if (error instanceof LinearAuthenticationError) {
    // Handle auth error
  } else if (error instanceof LinearRateLimitError) {
    // Handle rate limit
  }
}
```

## Priority Levels

Linear uses numeric priority levels:
- 0: No priority
- 1: Urgent
- 2: High
- 3: Normal (default)
- 4: Low

## Development

### Building
```bash
npm run build
```

### Testing
```bash
npm run test
```

### Linting
```bash
npm run lint
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests, please create an issue on the [GitHub repository](https://github.com/elizaos/eliza).
