/**
 * Agent Utilities
 *
 * Utility functions for agents
 */

export * from "./createTestAgent";
export * from "./prompt-builder";
export * from "./prompt-logger";
export * from "../shared/logger";
export * from "../shared/snowflake";

export function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}
