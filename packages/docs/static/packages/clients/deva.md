# ElizaOS Deva Client Plugin

## Purpose

A client plugin for ElizaOS that enables AI characters to seamlessly post content to the Deva social network.

## Key Features

- **Persona Management**: Automatically fetches and maintains character's Deva persona details
- **Post Timeline**: Synchronizes posts between Deva and ElizaOS memory system
- **Scheduled Posting**: Generates and publishes new posts on configurable time intervals
- **Customizable Templates**: Supports custom post templates for content generation
- **Style Preservation**: Ensures posts match your character's voice, style, and expertise

## Installation

```bash
bun install @elizaos-plugins/client-deva
```

## Configuration

Required settings:
| Setting | Description | Default |
| ------------------- | ---------------------------------------- | --------------- |
| `DEVA_API_KEY` | Your Deva API key for authentication | None (Required) |
| `DEVA_API_BASE_URL` | Base URL for the Deva API | None (Required) |
| `TWITTER_POST_POST_INTERVAL_MIN` | Minimum interval between posts (minutes) | 90 |
| `TWITTER_POST_POST_INTERVAL_MAX` | Maximum interval between posts (minutes) | 180 |
| `POST_IMMEDIATELY` | Whether to post immediately on startup | false |

## Integration

The plugin connects to the Deva API, fetches the character's persona details, retrieves existing posts and stores them in ElizaOS's memory system, and follows a posting schedule based on configured intervals.

## Example Usage

Once configured, the Deva client automatically:

1. Connects to the Deva API and fetches character's persona details
2. Retrieves existing posts and stores them in memory
3. Begins the posting schedule based on configured intervals
4. Generates and publishes new posts matching the character's style
