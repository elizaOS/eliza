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

For OpenAI-compatible endpoints, `ELIZA_OPENCODE_*` forwarding, and direct
provider selection, see [MODEL_PROVIDERS.md](MODEL_PROVIDERS.md).

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
│   ├── index.ts           # Interactive TUI entry point (`eliza-code`)
│   ├── acp.ts             # Agent Client Protocol entry point (`eliza-code-acp`)
│   ├── cli.ts             # CLI arg parsing / mode select
│   ├── App.ts             # Root TUI wiring
│   ├── components/        # Terminal UI components (@elizaos/tui)
│   │   ├── MainScreen.ts  # Composes status bar + chat/task split
│   │   ├── ChatPane.ts
│   │   ├── TaskPane.ts
│   │   ├── StatusBar.ts
│   │   └── HelpOverlay.ts
│   ├── lib/
│   │   ├── agent.ts          # Eliza runtime setup (loads plugin-openai etc.)
│   │   ├── model-provider.ts # Provider selection (ELIZA_CODE_PROVIDER)
│   │   ├── session.ts / store.ts  # Session + Zustand state
│   │   └── cwd.ts            # CWD tracking (no filesystem listing)
│   └── types.ts           # TypeScript types
└── scripts/
    └── write-dist-tsconfig.mjs  # Emits a paths-free dist/tsconfig.json (see Gotcha below)
```

> **Do not remove `scripts/write-dist-tsconfig.mjs` from the `build` script.** Bun applies the
> nearest tsconfig's `compilerOptions.paths` **at runtime**, and this package's tsconfig maps the
> externalized `@elizaos/plugin-*` to their types-only `.d.ts`. Without the emitted paths-free
> `dist/tsconfig.json`, `bun dist/index.js` loads a `.d.ts` and throws `ReferenceError` on first
> plugin import. The cockpit's PTY terminal (`@elizaos/plugin-pty`) spawns exactly this
> `dist/index.js` via `ELIZA_CODE_BIN`, so dropping the step silently re-breaks every cockpit
> terminal spawn (#11043).

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
- [@elizaos/tui](https://www.npmjs.com/package/@elizaos/tui) - Terminal UI framework
- [Zustand](https://zustand-demo.pmnd.rs/) - State management
- [Claude](https://anthropic.com) - AI model via Anthropic plugin
