export interface AcpConnectionTurnTeardown {
  cancelAllAndWait(timeoutMs: number): Promise<number>;
}

export interface AcpConnectionCloseOptions {
  timeoutMs: number;
  exit: (code: number) => void;
  onError?: (error: unknown) => void;
}

/** Install the hard process boundary for a stdio ACP connection. */
export function installAcpConnectionCloseTeardown(
  signal: AbortSignal,
  turns: AcpConnectionTurnTeardown,
  options: AcpConnectionCloseOptions,
): void {
  let started = false;
  const teardown = (): void => {
    if (started) return;
    started = true;
    // An async function executes synchronously through its first await.
    // cancelAllAndWait aborts every turn controller before yielding, then gives
    // cooperative providers/actions one short chance to unwind. The adapter
    // hard-exits regardless: it is detached from the parent process group, and
    // EOF otherwise leaves an uncooperative handler with mutation authority.
    void turns
      .cancelAllAndWait(options.timeoutMs)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => options.exit(0));
  };

  if (signal.aborted) {
    teardown();
  } else {
    signal.addEventListener("abort", teardown, { once: true });
  }
}
