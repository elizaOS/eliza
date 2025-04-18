# @elizaos/plugin-gitbook

## Purpose

A plugin for querying and retrieving information from GitBook documentation within the ElizaOS ecosystem.

## Key Features

- Natural language queries for documentation content
- Intelligent query validation
- Keyword-based filtering
- Clean response formatting

## Installation

```bash
bun install @elizaos/plugin-gitbook
```

## Configuration

### Environment Variables

```typescript
GITBOOK_SPACE_ID=<Your GitBook Space ID>
```

### Client Configuration (Optional)

```json
{
  "name": "YourCharacter",
  "plugins": ["gitbook"],
  "settings": {
    "gitbook": {
      "keywords": {
        "projectTerms": ["term1", "term2"],
        "generalQueries": ["custom1", "custom2"]
      },
      "documentTriggers": ["docs", "documentation"]
    }
  }
}
```

## Integration

```typescript
import { gitbookPlugin } from '@elizaos/plugin-gitbook';
```

## Example Usage

```typescript
'How do I get started with the project?';
'What are the main features?';
'Explain how to configure the system';
```
