/**
 * Example demonstrating type-safe state accumulation in workflows
 *
 * This example shows how TypeScript can infer and track state types
 * across workflow steps, providing IntelliSense and compile-time type checking.
 */

import { z } from 'zod';
import { createWorkflow, createStep } from '@mediar-ai/workflow';

// Define workflow input schema
const inputSchema = z.object({
  sourceFile: z.string(),
});

type WorkflowInput = z.infer<typeof inputSchema>;

// Step 1: Fetch user data
// This step produces state with userId and userName
const fetchUserStep = createStep<
  WorkflowInput,
  void,
  {},  // No state from previous steps
  { userId: string; userName: string }  // State this step produces
>({
  id: 'fetch-user',
  name: 'Fetch User Data',
  execute: async ({ input, logger }) => {
    logger.info(`Fetching user data from ${input.sourceFile}...`);

    // Simulate fetching user data
    const userId = '12345';
    const userName = 'John Doe';

    // Return typed state
    return {
      state: {
        userId,
        userName,
      },
    };
  },
});

// Step 2: Process data
// This step has access to userId and userName from previous step
const processDataStep = createStep<
  WorkflowInput,
  void,
  { userId: string; userName: string },  // State from previous step
  { processedCount: number; processedAt: Date }  // State this step produces
>({
  id: 'process-data',
  name: 'Process User Data',
  execute: async ({ context, logger }) => {
    // ✅ TypeScript knows context.state has userId and userName
    const { userId, userName } = context.state;

    logger.info(`Processing data for user ${userName} (ID: ${userId})...`);

    // Simulate processing
    const count = 42;
    const timestamp = new Date();

    return {
      state: {
        processedCount: count,
        processedAt: timestamp,
      },
    };
  },
});

// Step 3: Finalize
// This step has access to ALL accumulated state
const finalizeStep = createStep<
  WorkflowInput,
  void,
  {
    userId: string;
    userName: string;
    processedCount: number;
    processedAt: Date;
  },  // All state from previous steps
  { completedAt: Date }  // State this step produces
>({
  id: 'finalize',
  name: 'Finalize Processing',
  execute: async ({ context, logger }) => {
    // ✅ TypeScript knows ALL accumulated state
    const { userId, userName, processedCount, processedAt } = context.state;

    logger.success(
      `Completed processing ${processedCount} items for ${userName} (${userId})`
    );
    logger.info(`Processing started at: ${processedAt.toISOString()}`);

    return {
      state: {
        completedAt: new Date(),
      },
    };
  },
});

// Create workflow with automatic state type accumulation
const workflow = createWorkflow({
  name: 'Typed Data Processing Workflow',
  description: 'Demonstrates type-safe state accumulation across steps',
  input: inputSchema,
})
  .step(fetchUserStep)
  .step(processDataStep)
  .step(finalizeStep)
  .onSuccess(async ({ context, logger, duration }) => {
    // ✅ TypeScript knows the full final state type
    const {
      userId,
      userName,
      processedCount,
      processedAt,
      completedAt,
    } = context.state;

    logger.success('Workflow completed successfully!');
    logger.info(`User: ${userName} (${userId})`);
    logger.info(`Items processed: ${processedCount}`);
    logger.info(`Started: ${processedAt.toISOString()}`);
    logger.info(`Completed: ${completedAt.toISOString()}`);
    logger.info(`Duration: ${duration}ms`);
  })
  .build();

// Example usage:
// const result = await workflow.run({ sourceFile: 'users.json' });
// console.log(result);

export default workflow;
