import { type AgentRuntime, elizaLogger } from "@elizaos/core";

const DEFAULT_RUNTIME_LIFECYCLE_TIMEOUT_MS = 10_000;

function getRuntimeLifecycleTimeoutMs(): number {
  const configured = Number.parseInt(process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RUNTIME_LIFECYCLE_TIMEOUT_MS;
}

export async function runWithLifecycleTimeout(
  operation: Promise<void>,
  action: string,
  label: string,
  id: string,
): Promise<void> {
  const timeoutMs = getRuntimeLifecycleTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        elizaLogger.warn(`[${label}] ${action} timed out after ${timeoutMs}ms for ${id}`);
        resolve();
      }, timeoutMs);
      (timeout as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export const safeClose = async (
  closeable: { close(): Promise<void> },
  label: string,
  id: string,
): Promise<void> => {
  const closeOperation = closeable
    .close()
    .catch((e) => elizaLogger.debug(`[${label}] Close error for ${id}: ${e}`));
  await runWithLifecycleTimeout(closeOperation, "Close", label, id);
};

/** Stop runtime services without closing the shared database adapter pool. */
export async function stopRuntimeServices(
  runtime: AgentRuntime,
  id: string,
  label: string,
): Promise<void> {
  const stopOperation = runtime
    .stop()
    .catch((e) => elizaLogger.debug(`[${label}] Stop error for ${id}: ${e}`));
  await runWithLifecycleTimeout(stopOperation, "Stop", label, id);
}
