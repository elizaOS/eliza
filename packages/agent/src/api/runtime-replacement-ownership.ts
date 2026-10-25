/**
 * Cordon and drain the outgoing runtime before an API-visible replacement is
 * published. The server and explicit restart route share this boundary so two
 * runtime-local room queues can never own the same conversation concurrently.
 */

import type { AgentRuntime } from "@elizaos/core";

export async function quiesceRuntimeBeforeReplacement(
  previousRuntime: AgentRuntime | null,
  newRuntime: AgentRuntime,
): Promise<void> {
  if (!previousRuntime || previousRuntime === newRuntime) return;
  previousRuntime.roomHandlerQueue.closeAdmissions("runtime-replacement");
  await previousRuntime.roomHandlerQueue.quiesceAll();
}
