import type { AgentRuntime } from "@elizaos/core";

import { createTestRuntime as createPgliteRuntime } from "../../../../../../packages/core/test/helpers/pglite-runtime";

const runtimeCleanup = new WeakMap<AgentRuntime, () => Promise<void>>();

export async function createTestRuntime(): Promise<AgentRuntime> {
  const { runtime, cleanup } = await createPgliteRuntime();
  runtimeCleanup.set(runtime, cleanup);
  return runtime;
}

export async function cleanupTestRuntime(runtime: AgentRuntime): Promise<void> {
  const cleanup = runtimeCleanup.get(runtime);
  if (cleanup) {
    runtimeCleanup.delete(runtime);
    await cleanup();
  } else {
    await runtime.stop();
    await runtime.close();
  }
}
