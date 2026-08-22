/**
 * Bounds browser-bridge network operations across both header and body reads.
 * The timeout rejects independently of AbortSignal support so a stalled relay
 * cannot wedge the extension's singleton background sync loop indefinitely.
 */

export const BROWSER_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

export async function withBrowserBridgeRequestTimeout<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = BROWSER_BRIDGE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Browser bridge request timeout must be a positive finite number.",
    );
  }

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}
