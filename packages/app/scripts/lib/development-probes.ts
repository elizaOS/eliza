/** Transport probes only; callers own readiness, identity and reuse policy. */
import { createConnection } from "node:net";

function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new RangeError("Probe timeout must be a positive Node timer value");
  return value;
}

/** A listening socket is not proof of process identity or readiness. */
export function isPortOpen(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 800,
): Promise<boolean> {
  timeout(timeoutMs);
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Read a trusted host-selected health endpoint, including its body, within one
 * budget. Never follow redirects carrying private authorization headers.
 * Null means the probe did not produce usable successful JSON, not readiness.
 */
export async function readDevelopmentJson(
  url: string,
  options: {
    headers?: HeadersInit;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    timeout(options.timeoutMs ?? 2000),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  try {
    const response = await fetch(url, {
      headers: options.headers,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  } catch {
    // error-policy:J4 readiness probes report unavailability without logging credentials or body text.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
