---
name: clawd-code-skill
description: Development conventions and architecture guide for the Clawd Code CLI repository — a Solana-native AI coding agent with perps trading, image generation, voice, and x402 payments.
---

# Clawd Code — Repository Skill

## Project Overview

Clawd Code is the Solana-native AI coding CLI for the Clawd ecosystem. It supports file editing, shell commands, git workflows, code review, multi-agent coordination, IDE integration (VS Code, JetBrains), Model Context Protocol (MCP), perpetuals trading on Phoenix DEX, image generation, voice synthesis, and x402 payment-gated commerce.

**Codebase:** ~1,900 files, 512,000+ lines of TypeScript under `src/`.

## Tech Stack

| Component        | Technology                                      |
|------------------|------------------------------------------------|
| Language         | TypeScript (strict mode, ES modules)           |
| Runtime          | Bun (JSX support, `bun:bundle` feature flags)  |
| Terminal UI      | React + Ink (React for CLI)                    |
| CLI Parser       | Commander.js (`@commander-js/extra-typings`)   |
| API Client       | `@anthropic-ai/sdk` (Claude), native fetch (Grok, DeepSeek, OpenRouter) |
| Validation       | Zod v4                                         |
| Linter/Formatter | Biome                                          |
| Analytics        | PostHog (self-hosted analytics)                |
| Protocol         | Model Context Protocol (MCP)                   |
| Blockchain       | `@solana/web3.js`, Phoenix SDK, Vulcan MCP     |
| Payments         | x402 (HTTP 402 Payment Required via Solana)    |

## Architecture

### Directory Map (`src/`)

| Directory        | Purpose                                                         |
|------------------|-----------------------------------------------------------------|
| `commands/`      | ~50 slash commands (`/help`, `/wallet`, `/perps`, `/arena`, etc.)|
| `tools/`         | ~40 agent tools (Bash, FileRead, FileWrite, Glob, Grep, etc.)   |
| `components/`    | ~140 Ink/React UI components for terminal rendering             |
| `services/`      | External integrations (API, OAuth, MCP, LSP, analytics, plugins)|
| `bridge/`        | Bidirectional IDE communication layer                           |
| `state/`         | React context + custom store (AppState)                         |
| `hooks/`         | React hooks (permissions, keybindings, commands, settings)      |
| `types/`         | TypeScript type definitions                                     |
| `utils/`         | Utilities (shell, file ops, permissions, config, git)           |
| `screens/`       | Full-screen UIs (Doctor, REPL, Resume, Compact)                 |
| `skills/`        | Bundled skills + skill loader system                            |
| `plugins/`       | Plugin system (marketplace + bundled plugins)                   |
| `coordinator/`   | Multi-agent coordination & supervisor logic                     |
| `tasks/`         | Task management (shell tasks, agent tasks, teammates)           |
| `context/`       | React context providers (notifications, stats, FPS)             |
| `memdir/`        | Persistent memory system (CLAUDE.md, user/project memory)       |
| `entrypoints/`   | Initialization logic, Agent SDK, MCP entry                      |
| `voice/`         | Voice input/output (STT, TTS via sherpa-onnx)                   |
| `vim/`           | Vim mode keybinding support                                     |
| `schemas/`       | Zod configuration schemas                                       |
| `keybindings/`   | Keybinding configuration & resolver                             |
| `migrations/`    | Config migrations between versions                              |
| `outputStyles/`  | Output formatting & theming                                     |
| `query/`         | Query pipeline & processing                                     |
| `server/`        | Server/daemon mode                                              |
| `remote/`        | Remote session handling                                         |

### Key Files

| File                | Role                                                |
|---------------------|-----------------------------------------------------|
| `src/main.tsx`      | CLI entry point (Commander parser, startup profiling)|
| `src/QueryEngine.ts`| Core LLM API caller (streaming, tool-call loops)    |
| `src/Tool.ts`       | Tool type definitions & `buildTool` factory          |
| `src/tools.ts`      | Tool registry & presets                              |
| `src/commands.ts`   | Command registry                                     |
| `src/context.ts`    | System/user context collection (git status, memory)  |
| `src/cost-tracker.ts`| Token cost tracking                                 |
| `src/env.ts`        | Multi-provider env loader (Grok, Claude, DeepSeek)  |
| `src/arena.ts`      | Metaplex Agent Arena on-chain identity               |

### Entry Points & Initialization Sequence

1. `src/main.tsx` — Commander CLI parser, startup profiling
2. `src/entrypoints/init.ts` — Config, telemetry, OAuth, provider setup
3. `src/entrypoints/cli.tsx` — CLI session orchestration
4. `src/entrypoints/mcp.ts` — MCP server mode
5. `src/entrypoints/sdk/` — Agent SDK (programmatic API)
6. `src/replLauncher.tsx` — REPL session launcher

Startup performs parallel initialization: keychain prefetch, feature flag checks, wallet detection, then core init.

## Patterns & Conventions

### Tool Definition

Each tool lives in `src/tools/{ToolName}/` and uses `buildTool`:

```typescript
export const MyTool = buildTool({
  name: 'MyTool',
  aliases: ['my_tool'],
  description: 'What this tool does',
  inputSchema: z.object({
    param: z.string(),
  }),
  async call(args, context, canUseTool, parentMessage, onProgress) {
    // Execute and return { data: result, newMessages?: [...] }
  },
  async checkPermissions(input, context) { /* Permission checks */ },
  isConcurrencySafe(input) { /* Can run in parallel? */ },
  isReadOnly(input) { /* Non-destructive? */ },
  prompt(options) { /* System prompt injection */ },
  renderToolUseMessage(input, options) { /* UI for invocation */ },
  renderToolResultMessage(content, progressMessages, options) { /* UI for result */ },
})
```

**Directory structure per tool:** `{ToolName}.ts` or `.tsx` (main), `UI.tsx` (rendering), `prompt.ts` (system prompt), plus utility files.

### Command Definition

Commands live in `src/commands/` and follow three types:

- **PromptCommand** — Sends a formatted prompt with injected tools (most commands)
- **LocalCommand** — Runs in-process, returns text
- **LocalJSXCommand** — Runs in-process, returns React JSX

```typescript
const command = {
  type: 'prompt',
  name: 'my-command',
  description: 'What this command does',
  progressMessage: 'working...',
  allowedTools: ['Bash(git *)', 'FileRead(*)'],
  source: 'builtin',
  async getPromptForCommand(args, context) {
    return [{ type: 'text', text: '...' }]
  },
} satisfies Command
```

Commands are registered in `src/commands.ts` and invoked via `/command-name` in the REPL.

### Component Structure

- Functional React components with Ink primitives (`Box`, `Text`, `useInput()`)
- Styled with Chalk for terminal colors
- React Compiler for optimized re-renders
- Design system primitives in `src/components/design-system/`

### State Management

- `AppState` via React context + custom store (`src/state/AppStateStore.ts`)
- Mutable state object passed to tool contexts
- Selector functions for derived state
- Change observers in `src/state/onChangeAppState.ts`

### Permission System

- **Modes:** `default` (prompt per operation), `plan` (show plan, ask once), `bypassPermissions` (auto-approve), `auto` (ML classifier)
- **Rules:** Wildcard patterns — `Bash(git *)`, `FileEdit(/src/*)`
- Tools implement `checkPermissions()` returning `{ granted: boolean, reason?, prompt? }`

### Feature Flags & Build

Bun's `bun:bundle` feature flags enable dead-code elimination at build time:

```typescript
import { feature } from 'bun:bundle'
if (feature('PROACTIVE')) { /* proactive agent tools */ }
```

Notable flags: `PROACTIVE`, `KAIROS`, `BRIDGE_MODE`, `VOICE_MODE`, `COORDINATOR_MODE`, `DAEMON`, `WORKFLOW_SCRIPTS`.

## Naming Conventions

| Element      | Convention           | Example                          |
|-------------|---------------------|----------------------------------|
| Files       | PascalCase (exports) or kebab-case (commands) | `BashTool.tsx`, `commit-push-pr.ts` |
| Components  | PascalCase           | `App.tsx`, `PromptInput.tsx`     |
| Types       | PascalCase, suffix with Props/State/Context | `ToolUseContext`     |
| Hooks       | `use` prefix         | `useCanUseTool`, `useSettings`   |
| Constants   | SCREAMING_SNAKE_CASE | `MAX_TOKENS`, `DEFAULT_TIMEOUT_MS`|

## Import Practices

- ES modules with `.js` extensions (Bun convention)
- Lazy imports for circular dependency breaking: `const getModule = () => require('./heavy.js')`
- Conditional imports via feature flags or `process.env`
- `biome-ignore` markers for manual import ordering where needed

## Services

| Service             | Path                          | Purpose                           |
|--------------------|-------------------------------|-----------------------------------|
| API                | `services/api/`               | Multi-provider AI client (Grok/Claude/DeepSeek) |
| MCP                | `services/mcp/`               | MCP client, tool/resource discovery|
| OAuth              | `services/oauth/`             | OAuth 2.0 auth flow               |
| LSP                | `services/lsp/`               | Language Server Protocol manager   |
| Analytics          | `services/analytics/`         | PostHog analytics, telemetry, events |
| Plugins            | `services/plugins/`           | Plugin loader, marketplace        |
| Compact            | `services/compact/`           | Context compression                |
| x402 Payments      | `services/x402/`              | HTTP 402 payment routing on Solana |
| Vulcan             | `services/vulcan/`            | Phoenix perps MCP integration     |
| Token Estimation   | `services/tokenEstimation.ts` | Token count estimation            |

## Configuration

**Settings locations:**
- **Global:** `~/.clawd-code/config.json`, `~/.clawd-code/settings.json`
- **Project:** `.clawd/config.json`, `.clawd/settings.json`
- **System:** macOS Keychain
- **Config:** Also reads `~/.grok/config.toml` and `./.grok/config.toml` for xAI Grok-style settings

## Environment Variables

| Variable           | Purpose                           |
|--------------------|-----------------------------------|
| `ZAI_API_KEY`    | Z.AI API key for GLM-5.2 / GLM-5V / GLM-Image (default provider)|
| `ZAI_AGENT_BASE_URL` | Z.AI Agent API base URL for `slides_glm_agent` |
| `ZAI_CHART_MODEL` | Chart/report planning model (`glm-5.2`) |
| `ZAI_CHART_VISION_MODEL` | Chart mode vision model (`glm-5v-turbo`) |
| `ZAI_THINKING`   | Z.AI thinking mode (`enabled` or `disabled`) |
| `ZAI_REASONING_EFFORT` | GLM effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none` |
| `XAI_API_KEY`    | xAI Grok API key (optional provider + voice agent)|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key       |
| `DEEPSEEK_API_KEY` | DeepSeek API key               |
| `OPENROUTER_API_KEY` | OpenRouter API key            |
| `OPENROUTER_NEMO_MODEL1` | Balanced/free OpenRouter Nemo route |
| `OPENROUTER_NEMO_MODEL2` | Most-intelligent OpenRouter Nemo route |
| `OPENROUTER_NEMO_MODEL3` | Fast/free OpenRouter Nemo route |
| `OPENROUTER_FABLE5` | OpenRouter Claude Fable 5 route |
| `OPENROUTER_FABLE_LATESY` | OpenRouter Claude Fable latest route |
| `HELIUS_API_KEY` | Helius RPC/webhook access         |
| `SOLANA_RPC_URL` | Custom Solana RPC endpoint        |
| `SOLANA_CLUSTER` | Solana harness cluster label      |
| `SOLANA_COMMITMENT` | Solana harness commitment       |
| `SOLANA_HARNESS_READONLY` | Blocks mutation RPC by default |
| `LIVE_TRADING`   | Enable live perps trading (default: false)|
| `OPERATOR_CONFIRMED` | Required operator acknowledgement for live execution |
| `PERPS_SIM_ONLY` | Must be `false` before real perps execution |
| `IMPERIAL_ENABLED` | Enable Imperial API reads/routing |
| `IMPERIAL_LIVE` | Enable Imperial live order path after global gates pass |
| `IMPERIAL_WALLET` | Wallet pubkey bound to the Imperial JWT |
| `IMPERIAL_JWT` | Imperial mobile JWT; delegated trading credential |
| `IMPERIAL_PROFILE_INDEX` | Isolated Imperial profile index (`0..5`) |
| `IMPERIAL_DEFAULT_UNDERWRITER` | Imperial venue; `2` is Phoenix |

## MCP Tool Integration

Clawd Code connects to multiple MCP servers for Solana operations:

| MCP Server | Tools | Purpose |
|------------|-------|---------|
| Helius | DAS queries, webhooks, priority fees | Solana blockchain access |
| Vulcan | Trade execution, portfolio, market data | Phoenix perps trading |
| Imperial | Funding, portfolio, and live order routing | Solana perps router, Phoenix preferred |
| DFlow | Spot swaps, prediction markets | DeFi routing |
| Jupiter | Swap quotes, token lists | DEX aggregation |

## Guidelines

1. Read relevant source files before making changes — understand existing patterns first.
2. Follow the tool/command/component patterns above when adding new ones.
3. Keep edits minimal and focused — avoid unnecessary refactoring.
4. Use Zod for all input validation at system boundaries.
5. Gate experimental features behind `bun:bundle` feature flags or env checks.
6. Respect the permission system — tools that modify state must implement `checkPermissions()`.
7. Use lazy imports when adding dependencies that could create circular references.
8. Always default to PAPER mode for trades unless `LIVE_TRADING=true`, `OPERATOR_CONFIRMED=true`, and `PERPS_SIM_ONLY=false`.
9. Use `clawd-code chain` for Solana RPC inspection and `chain ask` for Z.AI-assisted harness planning.
10. Treat `IMPERIAL_JWT` like a private trading credential; never display, log, or commit it.
11. Never hardcode Solana addresses, transaction signatures, or prices — fetch them from RPC or the configured router.
12. Update this file as project conventions evolve.
