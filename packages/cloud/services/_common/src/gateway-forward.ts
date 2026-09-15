/** Runs gateway pod selection, fallback, wake-on-zero and bounded POST attempts while hosts retain replay and ingress policy. */

export type GatewayTargetResult =
  | { ok: true; response: string }
  | {
      ok: false;
      error: Error;
      isConnectionError: boolean;
      timedOut: boolean;
      status?: number;
    };

export interface GatewayForwardOptions {
  attempts: number;
  baseDelayMs: number;
  incrementMs: number;
  getTargets(): Promise<string[]>;
  refreshTargets(): Promise<void>;
  /** Starts one detached wake whose failure is observed by the host. */
  wake(): void;
  tryTarget(target: string): Promise<GatewayTargetResult>;
  retryOnTimeout: boolean;
  /** Optional host-specific ingress, attempted after a primary failure. */
  afterPrimaryFailure?(
    target: string,
    result: Extract<GatewayTargetResult, { ok: false }>,
  ): Promise<GatewayTargetResult | null>;
  sleep?(delayMs: number): Promise<void>;
  exhaustedError: Error;
}

export async function executeGatewayForwardAttempts(
  options: GatewayForwardOptions,
): Promise<string> {
  let lastError: Error | null = null;
  let woken = false;
  const sleep =
    options.sleep ??
    ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const rejectTerminalTimeout = (
    result: Extract<GatewayTargetResult, { ok: false }>,
  ): void => {
    if (result.timedOut && !options.retryOnTimeout) throw result.error;
  };

  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (attempt > 0)
      await sleep(options.baseDelayMs + options.incrementMs * attempt);
    const targets = await options.getTargets();
    if (targets.length === 0) {
      if (!woken) {
        woken = true;
        options.wake();
      }
      lastError = new Error("No pods available (scaled to zero)");
      continue;
    }

    const result = await options.tryTarget(targets[0]);
    if (result.ok) return result.response;
    rejectTerminalTimeout(result);
    const alternate = await options.afterPrimaryFailure?.(targets[0], result);
    if (alternate) {
      if (alternate.ok) return alternate.response;
      rejectTerminalTimeout(alternate);
    }

    if (targets.length > 1) {
      await options.refreshTargets();
      const fallback = await options.tryTarget(targets[1]);
      if (fallback.ok) return fallback.response;
      rejectTerminalTimeout(fallback);
    }
    lastError = result.error;
    if (!woken && result.isConnectionError) {
      woken = true;
      options.wake();
    }
  }
  throw lastError ?? options.exhaustedError;
}

export interface GatewayPostOptions {
  target: string;
  endpointPath: string;
  body: string;
  timeoutMs: number;
  sharedSecret?: string;
  forwardedHost?: string;
  /** Discord retains JSON response parsing; webhook hosts retain complete text. */
  readResponse(response: Response): Promise<string>;
  /** Hosts choose the timeout identity and whether it represents a connection failure. */
  timeoutError?: Error;
  timeoutIsConnectionError: boolean;
  fetchFn?: typeof fetch;
}

export async function postGatewayTarget(
  options: GatewayPostOptions,
): Promise<GatewayTargetResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(options.timeoutError),
    options.timeoutMs,
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.sharedSecret) headers["X-Server-Token"] = options.sharedSecret;
  if (options.forwardedHost)
    headers["X-Forwarded-Host"] = options.forwardedHost;
  const targetBase = /^https?:\/\//.test(options.target)
    ? options.target
    : `http://${options.target}`;

  try {
    const response = await (options.fetchFn ?? fetch)(
      `${targetBase}${options.endpointPath}`,
      {
        method: "POST",
        headers,
        body: options.body,
        signal: controller.signal,
      },
    );
    if (response.ok)
      return { ok: true, response: await options.readResponse(response) };
    return {
      ok: false,
      error: new Error(
        `Server returned ${response.status}: ${await response.text()}`,
      ),
      isConnectionError: false,
      timedOut: false,
      status: response.status,
    };
  } catch (error) {
    // error-policy:J1 The host receives a classified failed attempt and decides whether replay is allowed.
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      error:
        timedOut && options.timeoutError
          ? options.timeoutError
          : error instanceof Error
            ? error
            : new Error(String(error)),
      isConnectionError: !timedOut || options.timeoutIsConnectionError,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
