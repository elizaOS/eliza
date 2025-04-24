# @elizaos/plugin-asterai

## Purpose

A plugin for interacting with asterai plugins and agents to expand Eliza character's utility by giving it access to all the functionality of asterai's ecosystem.

## Installation

```bash
bun install @elizaos/plugin-asterai
```

## Configuration

The plugin requires environment variables:

```typescript
ASTERAI_AGENT_ID=
ASTERAI_PUBLIC_QUERY_KEY=
```

## Integration

Import in your code:

```typescript
import { asteraiPlugin } from '@elizaos/plugin-asterai';
```

## Example Usage

The plugin supports natural language for interacting with the asterai agent through your Eliza character:

```typescript
"Hey Eliza, how's the weather in LA?";
```

Eliza will query the asterai agent to fetch the information.
