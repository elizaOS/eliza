import type { IAgentRuntime } from "@elizaos/core";

/** Only for the dedicated Android CLI process after its stop signal. */
export async function shutdownAndroidBridge(
  closeIngress: () => Promise<void>,
  runtime: Pick<IAgentRuntime, "stop" | "close"> | undefined,
  log: (message: string) => void,
): Promise<never> {
  // A stalled service/DB/socket must not leave a stopped Android service's
  // resident child running. Timeout is failure, never successful teardown.
  const deadline = setTimeout(() => {
    log("[android-bridge] graceful shutdown deadline exceeded");
    process.exit(1);
  }, 10_000);
  try {
    const closed = closeIngress();
    // Observe close failures immediately while service teardown is in flight.
    const closeResult = closed.then(
      () => null,
      (error: unknown) => error,
    );
    await runtime?.stop();
    await runtime?.close();
    const closeError = await closeResult;
    if (closeError) throw closeError;
    log("[android-bridge] runtime and socket shutdown complete");
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    // Do not log provider/session payloads from arbitrary teardown errors.
    log("[android-bridge] graceful shutdown failed");
    clearTimeout(deadline);
    process.exit(1);
  }
}
