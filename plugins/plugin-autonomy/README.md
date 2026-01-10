# @elizaos/plugin-autonomy

A sophisticated autonomous agent plugin for ElizaOS that implements the OODA (Observe-Orient-Decide-Act) loop for intelligent decision-making.

## Overview

This plugin transforms ElizaOS agents into truly autonomous entities capable of:
- **Observing** their environment and gathering information
- **Orienting** themselves by analyzing patterns and context
- **Deciding** on optimal actions based on goals and priorities
- **Acting** on decisions with resource management
- **Learning** from outcomes to improve future performance

## Key Features

### OODA Loop Implementation
- Full Observe-Orient-Decide-Act cycle with reflection phase
- Adaptive behavior based on performance metrics
- Goal-driven decision making with priority management
- Resource-aware action execution

### Comprehensive Logging
- Structured logging with multiple levels (DEBUG, INFO, WARN, ERROR, FATAL)
- File-based logging with run tracking
- Phase-specific logging for each OODA cycle
- Metrics and performance tracking

### Real-World Scenarios
- Documentation research and report generation
- GitHub repository analysis
- System health monitoring
- Learning path execution

### Error Handling & Recovery
- Graceful degradation when dependencies are missing
- Error recovery strategies
- Resource constraint management
- Timeout handling for long-running actions

## Installation

```bash
npm install @elizaos/plugin-autonomy
```

## Configuration

### Environment Variables

```bash
# Logging Configuration
AUTONOMOUS_FILE_LOGGING=true          # Enable file logging
AUTONOMOUS_LOG_DIR=./logs/autonomy    # Log directory
AUTONOMOUS_LOG_LEVEL=INFO             # Log level (DEBUG, INFO, WARN, ERROR, FATAL)

# OODA Loop Configuration  
AUTONOMOUS_LOOP_INTERVAL=5000         # Base cycle time in milliseconds
AUTONOMOUS_MAX_CONCURRENT=3           # Maximum concurrent actions
AUTONOMOUS_ACTION_TIMEOUT=60000       # Action timeout in milliseconds
```

### Character Configuration

Add goals to your character configuration:

```json
{
  "name": "AutonomousAgent",
  "settings": {
    "goals": [
      {
        "id": "goal-1",
        "description": "Learn and improve capabilities",
        "priority": 1,
        "progress": 0
      },
      {
        "id": "goal-2", 
        "description": "Complete assigned tasks efficiently",
        "priority": 2,
        "progress": 0
      }
    ]
  }
}
```

## Usage

### Basic Setup

```typescript
import { autoPlugin } from "@elizaos/plugin-autonomy";

const agent = new Agent({
  plugins: [autoPlugin],
  character: {
    name: "AutonomousAgent",
    // ... other character config
  }
});
```

### With Additional Plugins

For full functionality, combine with other plugins:

```typescript
import { autoPlugin } from "@elizaos/plugin-autonomy";
import { todoPlugin } from "@elizaos/plugin-todo";
import { browserPlugin } from "@elizaos/plugin-browser";
import { shellPlugin } from "@elizaos/plugin-shell";

const agent = new Agent({
  plugins: [
    autoPlugin,
    todoPlugin,    // For task management
    browserPlugin, // For web interactions
    shellPlugin    // For system operations
  ]
});
```

## How It Works

### The OODA Loop

1. **Observe Phase**
   - Monitors active tasks and TODOs
   - Checks system resource status
   - Reviews recent messages and interactions
   - Tracks goal progress

2. **Orient Phase**
   - Analyzes observations for patterns
   - Updates environmental factors
   - Adjusts goal priorities
   - Identifies opportunities and constraints

3. **Decide Phase**
   - Makes urgent decisions for critical issues
   - Plans goal-based actions
   - Considers resource constraints
   - Evaluates alternatives

4. **Act Phase**
   - Executes chosen actions with timeouts
   - Manages concurrent operations
   - Tracks resource usage
   - Handles errors gracefully

5. **Reflect Phase**
   - Calculates success metrics
   - Updates historical context
   - Adjusts strategies based on outcomes
   - Learns from successes and failures

### Adaptive Behavior

The agent adapts its behavior based on:
- **Error rates**: Reduces concurrent actions if errors are high
- **Resource efficiency**: Increases activity when resources are available
- **Decision frequency**: Adjusts cycle time based on workload
- **Goal progress**: Reprioritizes based on achievement

## Logging

### File Logging Structure

When file logging is enabled, each OODA run creates a detailed log file:

```
logs/autonomy/
├── run_abc123_2024-01-20T10-30-00.log
├── run_def456_2024-01-20T10-35-00.log
└── ...
```

### Log Format

```json
{
  "runId": "abc123",
  "timestamp": 1705749000000,
  "level": "INFO",
  "phase": "DECIDING",
  "message": "Completed decision phase",
  "data": {
    "decisionCount": 2,
    "types": ["CONTINUE_TASK", "SYSTEM_HEALTH_CHECK"]
  }
}
```

### Viewing Logs

Use the included log viewer (coming soon) or parse JSON logs:

```bash
# View latest run
cat logs/autonomy/run_* | tail -n 100 | jq '.'

# Filter by phase
cat logs/autonomy/run_* | jq 'select(.phase == "DECIDING")'

# Check errors
cat logs/autonomy/run_* | jq 'select(.level == "ERROR")'
```

## Available Actions

### Documentation Research
```
"Research documentation on [topic]"
```
- Browses documentation sites
- Extracts key information
- Creates structured reports

### GitHub Analysis
```
"Analyze trending GitHub repositories in [language]"
"Analyze repository https://github.com/owner/repo"
```
- Explores trending repositories
- Clones and analyzes code
- Creates analysis summaries

### System Health
```
"Check system health"
```
- Monitors CPU, memory, disk usage
- Creates maintenance tasks
- Generates health reports

### Learning Paths
```
"Learn [technology] programming tutorial"
```
- Follows online tutorials
- Executes code examples
- Tracks learning progress

## Testing

### Run Tests

```bash
# Run all tests including OODA loop tests
npm test

# Run only E2E tests
npm run test:e2e
```

### Test Categories

1. **Unit Tests**: Component isolation tests
2. **E2E Tests**: Full OODA loop integration
3. **Scenario Tests**: Real-world task execution
4. **Performance Tests**: Resource usage and adaptation

## Development

### Adding Custom Goals

```typescript
const customGoals = [
  {
    id: generateId(),
    description: "Monitor competitor activity",
    priority: 1,
    progress: 0,
    subGoals: [
      // Optional sub-goals
    ]
  }
];

// Pass in character settings
const character = {
  settings: {
    goals: customGoals
  }
};
```

### Custom Actions

Implement actions that the OODA loop can execute:

```typescript
const customAction: Action = {
  name: "CUSTOM_ANALYSIS",
  description: "Performs custom analysis",
  validate: async (runtime, message) => {
    // Validation logic
    return true;
  },
  handler: async (runtime, message, state, options, callback) => {
    // Action implementation
    callback({
      text: "Analysis complete",
      actions: ["CUSTOM_ANALYSIS"],
    });
  }
};
```

## Troubleshooting

### Agent Not Making Decisions
- Check if tasks exist with appropriate tags
- Verify goal configuration
- Enable DEBUG logging to see OODA phases

### High Resource Usage
- Adjust `AUTONOMOUS_MAX_CONCURRENT`
- Increase `AUTONOMOUS_LOOP_INTERVAL`
- Check for resource-intensive actions

### Missing Dependencies
- Ensure required plugins are installed
- Check for `getTasks` method availability
- Review error logs for missing methods

## Future Roadmap

- [ ] Web UI for monitoring OODA cycles
- [ ] Cypress-based frontend testing
- [ ] Advanced learning algorithms
- [ ] Multi-agent coordination
- [ ] Plugin-specific goal templates
- [ ] Real-time metrics dashboard

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests to our repository.

## License

MIT
