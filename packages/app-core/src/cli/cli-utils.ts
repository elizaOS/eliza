/**
 * Wraps a CLI command action in error handling: runs the async action and, on
 * failure, either delegates to the optional `onError` callback or reports
 * through the runtime's `error` and exits with code 1.
 */
export async function runCommandWithRuntime(
  runtime: { error: (message: string) => void; exit: (code: number) => void },
  action: () => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (onError) {
      onError(err);
      return;
    }
    runtime.error(String(err));
    runtime.exit(1);
  }
}
