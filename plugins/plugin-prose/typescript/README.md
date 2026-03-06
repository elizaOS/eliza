# @elizaos/plugin-prose

OpenProse VM integration for elizaOS - a programming language for AI sessions.

## Overview

OpenProse is a programming language designed for orchestrating multi-agent AI workflows. When a `.prose` program is run, the agent "becomes" the OpenProse VM and executes the program by interpreting each statement according to the VM specification.

This plugin provides elizaOS actions and providers that enable agents to:
- Run `.prose` programs with `PROSE_RUN`
- Validate programs without execution with `PROSE_COMPILE`
- Get help and examples with `PROSE_HELP`

## Installation

```bash
bun add @elizaos/plugin-prose
```

## Usage

### Basic Usage

Register the plugin in your agent configuration:

```typescript
import { prosePlugin } from "@elizaos/plugin-prose";

const agent = {
  plugins: [prosePlugin],
  // ...
};
```

### Running Programs

Users can run prose programs with:

```
prose run workflow.prose
```

Or reference example programs:

```
prose run examples/hello-world.prose
```

### Validating Programs

Check program syntax without running:

```
prose compile workflow.prose
```

### Getting Help

```
prose help
prose examples
prose syntax
```

## Actions

### PROSE_RUN

Execute a `.prose` program.

**Triggers:**
- "prose run <file>"
- "run <file.prose>"
- "execute workflow.prose"

**Parameters (extracted from message):**
- `file` - Path to the .prose file
- `state_mode` - State management mode (optional, default: filesystem)
- `inputs_json` - JSON input arguments (optional)
- `cwd` - Working directory (optional)

### PROSE_COMPILE

Validate a `.prose` program without executing it.

**Triggers:**
- "prose compile <file>"
- "prose validate <file>"
- "check workflow.prose"

### PROSE_HELP

Get help with OpenProse syntax, commands, and examples.

**Triggers:**
- "prose help"
- "prose examples"
- "prose syntax"
- "how do I write a prose program"

## Provider

### prose

The prose provider supplies VM context when prose commands are detected. It:

- Detects prose-related commands in user messages
- Injects appropriate VM specification context
- Supports different state management modes
- Provides help and examples on demand

## Configuration

| Setting | Type | Description |
|---------|------|-------------|
| `PROSE_WORKSPACE_DIR` | string | Base directory for .prose workspace (default: ".prose") |
| `PROSE_STATE_MODE` | string | Default state mode: filesystem, in-context, sqlite, postgres |
| `PROSE_SKILLS_DIR` | string | Directory containing prose skill files |

## OpenProse Syntax

### Program Structure

```prose
program "name" version "1.0" {
    description "What this program does"
    required_capabilities [capability1, capability2]
    
    // Agent definitions
    define Agent researcher {
        system_prompt """You research topics thoroughly."""
        tools [search, browse]
    }
    
    // Sessions (entry points)
    session main(topic: string) -> result {
        findings <- researcher.complete("Research: " + topic)
        return { summary: findings }
    }
}
```

### Agent Definitions

```prose
define Agent name {
    system_prompt """..."""
    tools [tool1, tool2]
    temperature 0.7
}
```

### Sessions

```prose
session name(inputs) -> outputs {
    // Sequential execution
    result <- agent.complete(prompt)
    
    // Parallel execution
    [a, b] <- parallel {
        agent1.complete("Task A")
        agent2.complete("Task B")
    }
    
    // Conditional flow
    if condition {
        // ...
    } else {
        // ...
    }
    
    // Spawn subsessions
    sub <- spawn other_session(args)
    result <- await sub
    
    return { key: value }
}
```

### State Management

Programs can use different state backends:

- **filesystem** (default) - State stored in `.prose/runs/`
- **in-context** - State maintained in conversation memory
- **sqlite** - SQLite database for persistence
- **postgres** - PostgreSQL for distributed state

## How It Works

When a user requests to run a prose program:

1. The `PROSE_RUN` action extracts the file path and parameters
2. The program file is read and validated
3. A workspace directory is created (`.prose/runs/<run-id>/`)
4. The VM specification is loaded into the agent's context
5. The agent "becomes" the VM and executes the program
6. Sessions are executed using the Task tool to spawn subagents
7. State is persisted according to the configured state mode

## License

MIT
