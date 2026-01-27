# @elizaos/plugin-dev-orchestrator

Chat-driven development orchestration with AI coding agents (Claude Code, Cursor), git safety, and build automation for elizaOS.

## Features

- **AI Coding Agents**: Execute code changes via Claude Code CLI or Cursor CLI
- **Git Safety**: Automatic stashing, branching, and rollback on errors
- **Build Verification**: Auto-detect and run build commands with retry logic
- **Concurrency Modes**: 
  - **Trust Mode** (default): Fast parallel execution with repo-level locking
  - **Isolated Mode**: Branch-based isolation for guaranteed conflict-free execution
- **Command Approval**: Security layer for risky commands
- **Mobile-First UX**: Optimized for chat messengers with concise updates and tap-friendly controls
- **PM2 Integration**: Automatic service restarts on task completion

## Installation

```bash
bun add @elizaos/plugin-dev-orchestrator
```

## Configuration

Add to your agent's character file:

```json
{
  "plugins": ["@elizaos/plugin-dev-orchestrator"],
  "settings": {
    "DEV_ORCHESTRATOR_MODE": "trust",
    "DEV_ORCHESTRATOR_BUILD_CMD": "bun run build",
    "DEV_ORCHESTRATOR_RESTART_DEBOUNCE_MS": 10000,
    "DEV_ORCHESTRATOR_COMMAND_ALLOWLIST": "[\"bun install\", \"npm install\"]"
  }
}
```

### Environment Variables

- `DEV_ORCHESTRATOR_MODE`: Concurrency mode - `'trust'` (default) or `'isolated'`
- `DEV_ORCHESTRATOR_BUILD_CMD`: Override auto-detected build command
- `DEV_ORCHESTRATOR_RESTART_DEBOUNCE_MS`: Debounce time for PM2 restarts (default: 10000ms)
- `DEV_ORCHESTRATOR_COMMAND_ALLOWLIST`: JSON array of safe commands that don't require approval

## Usage

### Set Agent Preference

Set your preferred AI coding agent backend:

```
User: Use claude-code as my coding agent
Agent: ✅ Agent preference set to: **claude-code**

User: Set agent to auto-detect
Agent: ✅ Agent preference set to: **auto**
      🔍 Auto-detected agent: **claude-code**

      Available agents:
      • claude-code (recommended)

User: Prefer cursor for coding tasks
Agent: ✅ Agent preference set to: **cursor**
```

**Preference Modes:**
- `claude-code` - Always use Claude Code
- `cursor` - Always use Cursor
- `auto` - Auto-detect available agents (default)

**Persistence:**
- Preferences are saved per-user using elizaOS's entity/component system
- Preferences persist across sessions
- Each user can have their own preferred agent

### Submit a Coding Task

```
User: Fix the build errors in /home/user/myproject
Agent: ✅ Task submitted: #task-1234567890-abc

Project: /home/user/myproject
Prompt: Fix the build errors

📊 Queue: 0 waiting / 1 running
```

### Check Queue Status

```
User: Show me the task queue
Agent: 📊 **Queue Status**

0 waiting / 1 running

🔄 **#task-1234567890-abc** (running)
  Project: /home/user/myproject
  Prompt: Fix the build errors
```

### Approve Changes

```
User: Approve task #task-1234567890-abc
Agent: ✅ Task #task-1234567890-abc approved and changes committed!
```

### Reject Changes

```
User: Reject task #task-1234567890-abc because it broke the tests
Agent: ❌ Task #task-1234567890-abc rejected and changes rolled back.
Reason: because it broke the tests
```

## Architecture

### AI Coding Agents

The dev-orchestrator supports multiple AI coding agent backends:

#### 1. **Claude Code Agent** (Default, Recommended)
- Uses Claude Code CLI for task execution
- Superior code understanding and generation
- Built-in safety features and code analysis
- Requires: `claude` CLI in PATH

**Installation:**
```bash
# Follow installation instructions at https://claude.com/claude-code
# Ensure the CLI is available:
which claude
```

#### 2. **Cursor Agent** (Experimental)
- Uses Cursor CLI for task execution
- IDE-integrated coding assistance
- Requires: `cursor` CLI in PATH
- **Note:** CLI command structure is unverified - may need adjustment for your Cursor version

**Installation:**
```bash
# Install Cursor and ensure CLI is in PATH
which cursor
```

> ⚠️ **Cursor is experimental:** The CLI command (`cursor --prompt`) is a placeholder. 
> Run `cursor --help` to verify the actual API and update the agent if needed.
> Auto-approval support is unknown - may require manual interaction.

#### Selecting an Agent

You can specify which agent to use when submitting tasks:

```typescript
// Via API
const orchestrator = runtime.getService('DEV_ORCHESTRATOR');
await orchestrator.submitTask('/path/to/project', 'Fix the bug', 'claude-code');
await orchestrator.submitTask('/path/to/project', 'Add feature', 'cursor');
```

```
# Via chat (defaults to claude-code)
User: Fix the build errors in /home/user/myproject
User: Fix the build errors in /home/user/myproject using cursor
```

#### Agent Registry

The plugin uses a central **AgentRegistry** that manages available coding agents:

**Features:**
- **Auto-Detection**: Each agent registers only if its CLI binary is detected in PATH
- **Availability Checking**: Validates agent CLIs before use
- **Priority Ordering**: Recommends agents based on stability and capabilities
- **Singleton Pattern**: Single source of truth for agent availability

**How It Works:**
```typescript
// During plugin initialization
const registry = AgentRegistry.getInstance();

// Agents register with CLI detection
await registerAgentWithDetection('claude-code', new ClaudeCodeAgent(), 'claude', {
    displayName: 'Claude Code',
    isRecommended: true,
    isStable: true,
    description: 'AI coding assistant with superior code understanding',
});

// Check agent availability
if (registry.isAvailable('claude-code')) {
    const agent = registry.getAgent('claude-code');
    // Use the agent
}

// Get recommended agent
const recommended = registry.getRecommended();
console.log(`Using: ${recommended?.name}`);
```

**Registry Status:**
- Agents are only registered if their CLI is detected during initialization
- User preferences are validated against the registry
- Auto-detection uses registry's recommended agent
- See agent status in logs: `[DevOrchestratorService] Agent registry: 2/2 available, recommended: claude-code`

#### Agent Parsing from User Input

The registry includes smart parsing that detects agent selection from natural language:

```typescript
const registry = AgentRegistry.getInstance();
const agent = registry.parseAgentFromInput("Fix the bug using cursor");
// Returns: "cursor"
```

**Supported Patterns:**
- "using [agent]" - Fix the bug using cursor
- "with [agent]" - Add tests with claude
- "via [agent]" - Refactor via cursor-ai
- "in [agent]" - Update in claude-code
- "on [agent]" - Deploy on claudecode

**Aliases:**
Each agent registers aliases for flexible matching:
- Claude Code: `claude`, `claude-code`, `claudecode`
- Cursor: `cursor`, `cursor-ai`

**Examples:**
```
✅ "Fix using cursor" → cursor
✅ "Add tests with claude" → claude-code (via alias)
✅ "Refactor via cursor-ai" → cursor (via alias)
✅ "Fix the bug" → null (uses preference or auto-detect)
```

#### Agent Selection Flow

The system uses a three-tier priority for agent selection:

```
1. Explicit Request (Highest Priority)
   User says "using cursor" → Use cursor
        ↓ (if none specified)
2. User Preference
   Saved preference from SET_AGENT_PREFERENCE → Use saved agent
        ↓ (if not set or 'auto')
3. Auto-Detection (Lowest Priority)
   registry.getRecommended() → Use best available agent
```

This ensures users get their preferred agent while always having a working fallback.

### Git Service (Dual Implementation)

The dev-orchestrator uses a smart fallback system for git operations:

1. **Preferred: plugin-git adapter** - If `@elizaos/plugin-git` is available, uses GitServiceAdapter
   - Better security with path validation
   - Uses Bun.spawn() for all operations
   - Battle-tested and maintained separately

2. **Fallback: Legacy service** - If plugin-git is not available, uses GitServiceLegacy
   - Standalone implementation using Bun.spawn()
   - No external dependencies
   - Ensures dev-orchestrator works independently

The service is automatically selected at runtime:
```typescript
// Automatically uses plugin-git if available, falls back to legacy
const orchestrator = runtime.getService('DEV_ORCHESTRATOR');
```

### Concurrency Modes

**Trust Mode (Default)**
- Fast parallel execution
- Repo-level locking only
- Relies on Cursor's internal conflict handling
- Best for: Solo development, rapid iteration

**Isolated Mode**
- Each task gets its own git branch
- Sequential execution per repo
- Guaranteed conflict-free
- Automatic stash/restore of uncommitted changes
- Best for: Team environments, critical changes

### Workflow

1. **Submit Task** → Task added to queue
2. **Acquire Lock** → Repo-level lock acquired
3. **Snapshot** → Git stash uncommitted changes
4. **Branch** (isolated mode) → Create feature branch
5. **Execute** → Run Cursor CLI with prompt
6. **Build** → Verify build passes (with retry)
7. **Commit** → Commit changes
8. **Merge** (isolated mode) → Merge back to original branch
9. **Review** → Present changes for approval
10. **Approve/Reject** → Commit or rollback

### Command Approval

Risky commands require user approval:
- `rm -rf`, `sudo`
- Shell redirects (`>`)
- Network commands (`curl | sh`)
- `eval`, `exec`

Safe commands (auto-approved):
- `bun install`, `npm install`
- `bun run build`, `npm run build`
- `git status`, `git diff`, `git stash`

## Security & Authorization

The plugin includes comprehensive authorization controls. By default (no config), all users are allowed. Once configured, only specified users can execute actions.

### Configuration

Add to your `.env` or character settings:

```bash
# Authorized users (can submit tasks, view queue)
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["user123", "alice", "bob"]'

# Authorized roles (Discord/Telegram roles)
DEV_ORCHESTRATOR_AUTHORIZED_ROLES='["admin", "developer"]'

# Admin users (can approve/reject tasks)
DEV_ORCHESTRATOR_ADMIN_USERS='["admin123", "alice"]'

# Require approval for all actions (optional)
DEV_ORCHESTRATOR_REQUIRE_APPROVAL='false'
```

### Permission Levels

| Action | Required Permission |
|--------|---------------------|
| `SUBMIT_CODE_TASK` | Authorized user or role |
| `APPROVE_TASK` | Admin user only |
| `REJECT_TASK` | Admin user only |
| `ROLLBACK_CHANGES` | Authorized user |
| `QUEUE_STATUS` | Anyone (read-only) |

### Command Approval

Risky commands require user approval:
- `rm -rf`, `sudo`, `eval`, `exec`
- Shell redirects (`>`, `>>`)
- Network pipes (`curl | sh`, `wget | sh`)

Safe commands (auto-approved):
- `bun install`, `npm install`, `yarn install`
- `bun run build`, `npm run build`
- `git status`, `git diff`, `git stash`

See [SECURITY.md](./SECURITY.md) for complete documentation.

## Actions

- `SET_AGENT_PREFERENCE`: Set preferred AI coding agent (claude-code, cursor, or auto)
- `SUBMIT_CODE_TASK`: Submit a coding task
- `QUEUE_STATUS`: Show task queue status
- `APPROVE_TASK`: Approve a task and commit changes
- `REJECT_TASK`: Reject a task and rollback changes
- `ROLLBACK_CHANGES`: Rollback uncommitted changes in a project

## API

### DevOrchestratorService

```typescript
import { DevOrchestratorService } from '@elizaos/plugin-dev-orchestrator';

// Get service from runtime
const orchestrator = runtime.getService('DEV_ORCHESTRATOR') as DevOrchestratorService;

// Submit a task
const task = await orchestrator.submitTask(
  '/path/to/project',
  'Fix the build errors'
);

// Get queue status
const status = orchestrator.getQueueStatus();
console.log(`${status.pending} waiting / ${status.running} running`);

// Approve a task
await orchestrator.approveTask(task.id);

// Reject a task
await orchestrator.rejectTask(task.id, 'Broke the tests');
```

### Interfaces

```typescript
import type { ICodingAgent, Task, AgentResult } from '@elizaos/plugin-dev-orchestrator';

// Implement a custom coding agent
class MyAgent implements ICodingAgent {
  getName(): string {
    return 'my-agent';
  }

  async execute(task: Task, runtime: IAgentRuntime): Promise<AgentResult> {
    // Your implementation
  }

  async fixError(error: string, task: Task, runtime: IAgentRuntime): Promise<AgentResult> {
    // Your implementation
  }
}
```

## Development

```bash
# Build
bun run build

# Watch mode
bun run dev

# Test
bun run test
```

## Roadmap

- [x] Claude Code agent backend (✅ Completed)
- [x] Cursor agent backend (✅ Completed)
- [ ] Support for additional agents (Codex, Aider, etc.)
- [ ] Diff image generation for mobile review
- [ ] Web UI for detailed code review
- [ ] Multi-agent worker pools
- [ ] Task bundling and prioritization
- [ ] Integration with GitHub/GitLab for PR creation

## License

MIT

