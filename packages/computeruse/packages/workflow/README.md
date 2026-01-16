# @mediar-ai/workflow

TypeScript SDK for building ComputerUse workflows with type safety, error recovery, and easy parsing for mediar-app UI.

## Installation

```bash
npm install @mediar-ai/workflow zod
```

## Quick Start

```typescript
import { createStep, createWorkflow, z } from '@mediar-ai/workflow';

// Define input schema
const InputSchema = z.object({
  userName: z.string().default('World'),
});

// Create steps
const openApp = createStep({
  id: 'open-app',
  name: 'Open Notepad',
  execute: async ({ desktop }) => {
    desktop.openApplication('notepad');
    await desktop.delay(2000);
  },
});

const typeGreeting = createStep({
  id: 'type-greeting',
  name: 'Type Greeting',
  execute: async ({ desktop, input }) => {
    const textbox = await desktop.locator('role:Edit').first(2000);
    await textbox.typeText(`Hello, ${input.userName}!`);
  },
});

// Create workflow
const workflow = createWorkflow({
  name: 'Simple Demo',
  input: InputSchema,
})
  .step(openApp)
  .step(typeGreeting)
  .build();

// Run it
workflow.run({ userName: 'Alice' });
```

## Features

### ✅ Type Safety

Full TypeScript support with Zod schemas:

```typescript
const InputSchema = z.object({
  jsonFile: z.string().describe('Path to JSON file'),
  maxRetries: z.number().default(3).min(0).max(10),
  sendEmail: z.boolean().default(true),
});

type Input = z.infer<typeof InputSchema>; // Fully typed!
```

### ✅ Error Recovery

Built-in error recovery and retry logic:

```typescript
const step = createStep({
  execute: async ({ desktop }) => {
    // Your logic
  },
  onError: async ({ error, retry, attempt }) => {
    if (error.message.includes('temporary')) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return retry();
    }
    return { recoverable: false };
  },
});
```

### ✅ Context Sharing

Share state between steps using `return { state: {...} }`:

```typescript
const step1 = createStep({
  execute: async ({ context }) => {
    return { state: { userId: 123 } };
  },
});

const step2 = createStep({
  execute: async ({ context }) => {
    console.log(context.state.userId); // 123
  },
});
```

### ✅ Conditional Execution

Steps run conditionally:

```typescript
const step = createStep({
  condition: ({ input }) => input.sendEmail === true,
  execute: async ({ desktop }) => {
    // Only runs if sendEmail is true
  },
});
```

### ✅ Success/Error Handlers

Workflow-level handlers:

```typescript
const workflow = createWorkflow({ ... })
  .step(step1)
  .onSuccess(async ({ logger }) => {
    logger.success('All done!');
  })
  .onError(async ({ error, step }) => {
    console.error(`Failed at: ${step.config.name}`);
  })
  .build();
```

## API Reference

### `createStep(config)`

Creates a workflow step.

**Parameters:**
- `config.id` - Unique step identifier
- `config.name` - Human-readable name
- `config.description` - Optional description
- `config.execute` - Main execution function
- `config.onError` - Optional error recovery function
- `config.timeout` - Optional timeout in ms
- `config.condition` - Optional condition function

### `createWorkflow(config)`

Creates a workflow builder.

**Parameters:**
- `config.name` - Workflow name
- `config.description` - Optional description
- `config.version` - Optional version
- `config.input` - Zod input schema

**Methods:**
- `.step(step)` - Add a step
- `.onSuccess(handler)` - Set success handler
- `.onError(handler)` - Set error handler
- `.build()` - Build the workflow

## Control Flow

### Early Success

Complete the workflow early and skip remaining steps:

```typescript
import { createStep, success } from '@mediar-ai/workflow';

const checkFiles = createStep({
  id: 'check-files',
  name: 'Check Files',
  execute: async () => {
    if (noFilesFound) {
      return success({
        message: 'No files to process',
        data: { filesChecked: 0 }
      });
    }
    return { state: { hasFiles: true } };
  },
});
```

### Step Navigation

Jump to a specific step:

```typescript
import { createStep, next } from '@mediar-ai/workflow';

const checkDuplicate = createStep({
  id: 'check-duplicate',
  name: 'Check Duplicate',
  execute: async ({ context }) => {
    if (context.state.isDuplicate) {
      return next('handle_duplicate'); // Jump to handle_duplicate step
    }
    return { state: { checked: true } };
  },
});
```

### Retry from Execute

Retry the current step:

```typescript
import { createStep, retry } from '@mediar-ai/workflow';

const clickButton = createStep({
  id: 'click-button',
  name: 'Click Button',
  execute: async ({ desktop }) => {
    const button = await desktop.locator('role:Button').first(1000);
    if (!button) {
      return retry(); // Re-execute this step
    }
    await button.click();
  },
});
```

### Automatic Retries

Use `retries` for simple retry logic with exponential backoff:

```typescript
const flakyStep = createStep({
  id: 'flaky-step',
  name: 'Flaky Operation',
  retries: 3,        // Retry up to 3 times
  retryDelayMs: 1000, // Start with 1s delay (doubles each retry)
  execute: async ({ desktop }) => {
    await desktop.locator('role:Button').first(2000);
  },
});
```

### Post-Execution Validation

Validate step outcomes with `expect`:

```typescript
const submitForm = createStep({
  id: 'submit-form',
  name: 'Submit Form',
  execute: async ({ desktop }) => {
    await desktop.locator('role:Button|name:Submit').first(2000);
  },
  expect: async ({ desktop }) => {
    const successMsg = await desktop.locator('name:Success').first(3000);
    return {
      success: !!successMsg,
      message: successMsg ? 'Form submitted' : 'Success message not found',
    };
  },
});
```

## Examples

See `examples/simple_notepad_workflow/` for a complete example:

- `src/computeruse.ts` - Main workflow definition
- `src/steps/` - Individual step modules

## License

MIT
