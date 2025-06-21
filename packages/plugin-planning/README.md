# @elizaos/plugin-strategy

A strategy planning and execution plugin for ElizaOS that demonstrates action chaining functionality with data passing and abort controller support.

## Features

- **Action Chaining**: Chain multiple actions together with data passing between them
- **Abort Controller Support**: Cancel action chains mid-execution with proper cleanup
- **Message Classification**: Automatically classify messages to determine if they need strategic planning
- **Conditional Execution**: Actions can decide whether to continue the chain based on their results

## Installation

```bash
npm install @elizaos/plugin-strategy
```

## Usage

### Basic Setup

```typescript
import { strategyPlugin } from '@elizaos/plugin-strategy';

// Register the plugin with your agent runtime
runtime.registerPlugin(strategyPlugin);
```

### Action Chaining Example

The plugin includes example actions that demonstrate chaining:

1. **ANALYZE_INPUT**: Analyzes user input and extracts key information
2. **PROCESS_ANALYSIS**: Processes the analysis results and makes decisions
3. **EXECUTE_FINAL**: Executes the final action based on processing results

These actions automatically chain together, passing data from one to the next:

```typescript
// In your message handler, specify multiple actions
const response = {
  content: {
    actions: ['ANALYZE_INPUT', 'PROCESS_ANALYSIS', 'EXECUTE_FINAL'],
    thought: 'I will analyze your message and respond appropriately',
  },
};

// The runtime will execute them in sequence with data passing
const results = await runtime.processActions(message, [response], state);
```

### Creating Chained Actions

To create your own chained actions:

```typescript
import { IAction, ActionResult, ActionOptions } from '@elizaos/core';

export const myFirstAction: IAction = {
  name: 'MY_FIRST_ACTION',
  description: 'First action in the chain',
  returnsData: true, // Indicates this action returns data

  handler: async (runtime, message, state, options) => {
    // Your action logic here
    const data = { computed: 'value' };

    return {
      success: true,
      data, // This data will be available to the next action
      continueChain: true, // Continue to next action
      metadata: { duration: 100 },
    };
  },
};

export const mySecondAction: IAction = {
  name: 'MY_SECOND_ACTION',
  description: 'Second action that uses data from first',
  acceptsInput: true, // Indicates this action accepts input
  requiresPreviousResult: true, // Requires previous action result

  handler: async (runtime, message, state, options) => {
    // Access previous results
    const previousData = options?.previousResults?.[0]?.data;

    // Use the data from the previous action
    const result = processData(previousData);

    return {
      success: true,
      data: result,
      continueChain: false, // End the chain
      cleanup: async () => {
        // Optional cleanup function if aborted
        console.log('Cleaning up resources');
      },
    };
  },
};
```

### Abort Controller Support

Actions can be aborted mid-execution:

```typescript
const controller = new AbortController();

// Set a timeout
setTimeout(() => controller.abort(), 5000); // Abort after 5 seconds

// Pass the abort signal to processActions
try {
  const results = await runtime.processActions(
    message,
    [response],
    state,
    callback,
    controller.signal
  );
} catch (error) {
  if (error.message === 'Action chain aborted') {
    console.log('Chain was aborted');
  }
}
```

### Message Classification

The plugin includes a message classifier provider that categorizes messages:

- **SIMPLE**: Basic requests that can be handled with a single action
- **STRATEGIC**: Complex requests requiring multi-step planning
- **CAPABILITY_REQUEST**: Requests for new capabilities or integrations
- **RESEARCH_NEEDED**: Requests requiring research or information gathering

## API Reference

### ActionResult Interface

```typescript
interface ActionResult {
  data?: any; // Data to pass to next action
  success: boolean; // Whether the action succeeded
  error?: string; // Error message if failed
  continueChain?: boolean; // Whether to continue the chain
  metadata?: Record<string, any>; // Additional metadata
  cleanup?: () => Promise<void>; // Cleanup function if aborted
}
```

### ActionOptions Interface

```typescript
interface ActionOptions {
  previousResults?: ActionResult[]; // Results from previous actions
  abortSignal?: AbortSignal; // Signal to check for abort
  chainContext?: {
    chainId: string; // Unique ID for this chain
    totalActions: number; // Total number of actions
    currentIndex: number; // Current action index
  };
}
```

## Testing

Run the tests to see action chaining in action:

```bash
npm test
```

## Contributing

This plugin demonstrates the core action chaining functionality. Feel free to extend it with:

- More sophisticated planning algorithms
- Integration with external services
- Complex DAG execution
- Advanced error recovery strategies

## License

MIT
