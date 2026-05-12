/**
 * @fileoverview Test utilities for Code app tests.
 *
 * Uses the current core testing helpers instead of the removed bootstrap
 * test-utils path.
 */

import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  InMemoryDatabaseAdapter,
  type State,
  type UUID,
} from "@elizaos/core";
import {
  createTestMemory,
  createTestRuntime,
  type TestRuntimeOptions,
  type TestRuntimeResult,
} from "@elizaos/core/testing";

export { createTestMemory, createTestRuntime };

type CleanupTarget =
  | TestRuntimeResult
  | IAgentRuntime
  | {
      cleanup?: () => Promise<void> | void;
      runtime?: IAgentRuntime;
    };

export function createUUID(): UUID {
  return crypto.randomUUID() as UUID;
}

export function createTestDatabaseAdapter(): IDatabaseAdapter {
  return new InMemoryDatabaseAdapter();
}

export function createTestState(overrides: Partial<State> = {}): State {
  return {
    values: {},
    data: {},
    text: "",
    ...overrides,
  } as State;
}

export async function cleanupTestRuntime(
  target?: CleanupTarget,
): Promise<void> {
  if (!target) return;
  if ("cleanup" in target && typeof target.cleanup === "function") {
    await target.cleanup();
    return;
  }

  const runtime =
    "runtime" in target && target.runtime
      ? target.runtime
      : (target as IAgentRuntime);
  await runtime.stop?.();
  await runtime.close?.();
}

export async function setupActionTest(
  options?: TestRuntimeOptions,
): Promise<TestRuntimeResult> {
  return createTestRuntime(options);
}
