# Eliza Code

An async coding agent terminal app built on ElizaOS - like Claude Code, but with fully asynchronous task execution and continuous conversation.

## Features

- **Dual-Pane Terminal UI**: Chat pane for conversation, task pane for monitoring progress
- **Async Task Execution**: Tasks run in the background while you continue chatting
- **Multiple Chat Rooms**: Create separate conversation contexts
- **Coding Tools**: File operations, shell commands, search, and more
- **Task Context Injection**: The agent knows about ongoing tasks and their progress

## Prerequisites

- [Bun](https://bun.sh/) runtime
- OpenAI or Anthropic API key

## Installation

```bash
cd eliza-code
bun install
```

## Configuration

Copy the environment example and add your API key:

```bash
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY or ANTHROPIC_API_KEY
```

## Usage

Start Eliza Code:

```bash
bun start
```

### Keyboard Shortcuts

| Key        | Action                                      |
| ---------- | ------------------------------------------- |
| `Enter`    | Send message                                |
| `Tab`      | Toggle focus between chat/task panes        |
| `Ctrl+N`   | Create new chat room                        |
| `Ctrl+Q`   | Quit                                        |
| `Ctrl+↑/↓` | Scroll chat history or task output          |
| `↑/↓`      | Navigate task list (when task pane focused) |

### Example Commands

Once running, you can chat with the agent:

```
> list files in src
> read the package.json
> search for "TODO" in the codebase
> run npm test
> create a task to implement user authentication
```

## Architecture

```
eliza-code/
├── src/
│   ├── index.tsx          # Entry point
│   ├── App.tsx            # Main layout
│   ├── components/        # Ink UI components
│   │   ├── ChatPane.tsx
│   │   ├── TaskPane.tsx
│   │   ├── StatusBar.tsx
│   │   └── MessageBubble.tsx
│   ├── lib/
│   │   ├── agent.ts       # Eliza runtime setup
│   │   ├── chat-manager.ts
│   │   ├── task-manager.ts
│   │   └── store.ts       # Zustand state
│   ├── lib/cwd.ts         # CWD tracking (no filesystem listing)
│   └── types.ts           # TypeScript types
```

## Available Actions

The agent can use these actions:

In this example, the **main agent** is an orchestrator (no filesystem tools). It uses:

- **@elizaos/plugin-agent-orchestrator**: task creation + lifecycle (CREATE_TASK, LIST_TASKS, etc.)
- **@elizaos/plugin-shell**: shell execution (when enabled) for high-level commands

All file reading/writing/editing and detailed repo work happens inside **worker sub-agents** (Codex, Claude Code, SWE-agent, etc.).

## How It Works

1. **Chat with the agent** in the left pane
2. **Watch tasks execute** in the right pane
3. Tasks run **asynchronously** - you can continue chatting while they work
4. The agent receives **task context** so it knows what's happening
5. Switch between tasks to view different outputs

## Development

```bash
# Run with watch mode
bun dev

# Type check
bun run tsc --noEmit
```

## Built With

- [ElizaOS](https://elizaos.github.io/eliza/) - Agent framework
- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [Zustand](https://zustand-demo.pmnd.rs/) - State management
- [Claude](https://anthropic.com) - AI model via Anthropic plugin
