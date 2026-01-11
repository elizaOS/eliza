# elizaos-plugin-linear

Python implementation of the Linear integration plugin for ElizaOS.

## Features

- **Issue Management**: Create, read, update, delete, and search issues
- **Comment Management**: Add comments to issues
- **Team Operations**: List and filter teams
- **Project Management**: List and filter projects
- **Activity Tracking**: Track and view Linear operations
- **Natural Language Understanding**: LLM-powered parsing of user requests

## Installation

```bash
pip install elizaos-plugin-linear
```

## Configuration

Set these environment variables:

```bash
export LINEAR_API_KEY=your_api_key          # Required
export LINEAR_WORKSPACE_ID=your_workspace   # Optional
export LINEAR_DEFAULT_TEAM_KEY=ENG          # Optional
```

## Usage

```python
from elizaos_plugin_linear import linear_plugin

# Register with your ElizaOS agent
agent.register_plugin(linear_plugin)
```

## Actions

| Action                  | Description               |
| ----------------------- | ------------------------- |
| `CREATE_LINEAR_ISSUE`   | Create a new issue        |
| `GET_LINEAR_ISSUE`      | Get issue details         |
| `UPDATE_LINEAR_ISSUE`   | Update an existing issue  |
| `DELETE_LINEAR_ISSUE`   | Archive an issue          |
| `SEARCH_LINEAR_ISSUES`  | Search for issues         |
| `CREATE_LINEAR_COMMENT` | Add a comment to an issue |
| `LIST_LINEAR_TEAMS`     | List teams                |
| `LIST_LINEAR_PROJECTS`  | List projects             |
| `GET_LINEAR_ACTIVITY`   | View activity log         |
| `CLEAR_LINEAR_ACTIVITY` | Clear activity log        |

## Providers

| Provider          | Description                   |
| ----------------- | ----------------------------- |
| `LINEAR_ISSUES`   | Context about recent issues   |
| `LINEAR_TEAMS`    | Context about teams           |
| `LINEAR_PROJECTS` | Context about projects        |
| `LINEAR_ACTIVITY` | Context about recent activity |

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy src

# Linting
ruff check src
```

## License

MIT



