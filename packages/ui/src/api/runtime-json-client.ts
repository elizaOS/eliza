/** JSON-only product runtime client. Hosts choose bridges, URLs, budgets and copy.
 * An available native runtime owns the request: its failures never select HTTP.
 * No credentials, retries or request replay are introduced here. Only with
 * reuseRunningStatus is a request the bridge reports as undispatched
 * (RUNTIME_NOT_READY) sent after startup, and only to an available runtime.
 */
import {
  type AgentRequestTransport,
  fetchAgentTransport,
} from "./transport.ts";
export interface RuntimeStatus {
  available: boolean;
  state: string;
  error?: string;
  /**
   * Largest request body the native bridge admits, in UTF-16 units of the body
   * as the host serializes it. An upper bound: JSON.stringify can be shorter
   * (Android org.json escapes `/`). Absent when no native runtime is available.
   */
  requestBodyLimit?: number;
}
export interface RuntimeJsonResponse {
  status: number;
  data: unknown;
}
export interface RuntimeJsonBridge {
  status(): Promise<RuntimeStatus>;
  start(): Promise<RuntimeStatus>;
  restart(): Promise<RuntimeStatus>;
  request(input: {
    path: string;
    method: "GET" | "POST";
    body?: unknown;
    /**
     * Opaque request ID that a wrapping bridge adds for native host logs.
     * The client never sets it. It must not carry content or credentials.
     */
    correlation?: string;
  }): Promise<RuntimeJsonResponse>;
}
/**
 * Rejection code a bridge gives when it did not dispatch a request because the
 * runtime is not running. Nothing reached the runtime, so the client may wait
 * for startup and dispatch it once more.
 */
export const RUNTIME_NOT_READY = "RUNTIME_NOT_READY";
const notReady = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === RUNTIME_NOT_READY;
export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Seconds to wait before trying again, only when the runtime reported it. */
  readonly retryAfter?: number;
  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
    if (Number.isSafeInteger(retryAfter) && (retryAfter as number) >= 0)
      this.retryAfter = retryAfter;
  }
}
export function createRuntimeJsonClient(options: {
  nativePlatform: () => boolean;
  nativeBridge: () => RuntimeJsonBridge | null;
  nativeFallback: (path: string, body: unknown) => Promise<RuntimeJsonResponse>;
  webUrl: (path: string) => string;
  webTransport?: AgentRequestTransport;
  startupTimeoutMs: number;
  pollMs: number;
  requestTimeoutMs: number;
  /**
   * Skip the per-request status probe while this account generation's runtime
   * was last seen running. Set it only for a bridge that rejects undispatched
   * requests with RUNTIME_NOT_READY; any other rejection or a 503 probes again.
   * Without that mapping, the first request after a runtime stop the client did
   * not see (a service kill or restart) fails instead of starting the runtime.
   * Off, the client probes before every request and resends nothing.
   */
  reuseRunningStatus?: boolean;
  messages: {
    invalidPath: string;
    startup: string;
    changed: string;
    request: string;
    fallback: string;
    invalidJson: string;
  };
}) {
  for (const value of [
    options.startupTimeoutMs,
    options.pollMs,
    options.requestTimeoutMs,
  ])
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      throw new RangeError("Invalid runtime client budget");
  let generation = 0;
  let starting: { generation: number; promise: Promise<void> } | undefined;
  let refreshing: { generation: number; promise: Promise<void> } | undefined;
  let refreshFailure: { generation: number; error: unknown } | undefined;
  // The generation whose runtime was last seen running (reuseRunningStatus only).
  let running: number | undefined;
  const seenRunning = (epoch: number) => {
    if (options.reuseRunningStatus && generation === epoch) running = epoch;
  };
  const forget = (epoch: number) => {
    if (running === epoch) running = undefined;
  };
  const current = (epoch: number) => {
    if (epoch !== generation) throw new Error(options.messages.changed);
  };
  const ensure = (
    bridge: RuntimeJsonBridge,
    status: RuntimeStatus,
    epoch: number,
  ) => {
    current(epoch);
    if (status.state === "running") return Promise.resolve();
    if (starting?.generation === epoch) return starting.promise;
    const deadline = performance.now() + options.startupTimeoutMs;
    let settled = false;
    const check = () => {
      current(epoch);
      if (settled || performance.now() >= deadline)
        throw new Error(options.messages.startup);
    };
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(options.messages.startup)),
        options.startupTimeoutMs,
      );
    });
    const pending = Promise.race([
      expired,
      (async () => {
        let state = status.state === "starting" ? status : await bridge.start();
        check();
        while (state.state === "starting" && performance.now() < deadline) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(
                options.pollMs,
                Math.max(1, deadline - performance.now()),
              ),
            ),
          );
          check();
          state = await bridge.status();
          check();
        }
        if (state.state !== "running")
          throw new Error(state.error || options.messages.startup);
      })(),
    ]).finally(() => {
      settled = true;
      clearTimeout(timer);
    });
    const entry = {
      generation: epoch,
      promise: pending.finally(() => {
        if (starting === entry) starting = undefined;
      }),
    };
    starting = entry;
    return entry.promise;
  };
  const result = <T>(response: RuntimeJsonResponse): T => {
    if (response.status < 200 || response.status >= 300) {
      const data = response.data as {
        error?: unknown;
        code?: unknown;
        retryAfter?: unknown;
      } | null;
      throw new RuntimeRequestError(
        typeof data?.error === "string" ? data.error : options.messages.request,
        response.status,
        typeof data?.code === "string" ? data.code : undefined,
        response.status === 429 && typeof data?.retryAfter === "number"
          ? data.retryAfter
          : undefined,
      );
    }
    return response.data as T;
  };
  return {
    async refreshNativeAccount() {
      // Revoking a bridge still invalidates work dispatched through the old account.
      const epoch = ++generation;
      refreshFailure = undefined;
      if (!options.nativePlatform()) return;
      const bridge = options.nativeBridge();
      if (!bridge) return;
      const deadline = performance.now() + options.startupTimeoutMs;
      let settled = false;
      const check = () => {
        current(epoch);
        if (settled || performance.now() >= deadline)
          throw new Error(options.messages.startup);
      };
      let timer: ReturnType<typeof setTimeout>;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(options.messages.startup)),
          options.startupTimeoutMs,
        );
      });
      const entry = {
        generation: epoch,
        promise: Promise.race([
          expired,
          Promise.resolve().then(async () => {
            check();
            const status = await bridge.status();
            check();
            if (!status.available) return;
            const restarted = await bridge.restart();
            check();
            await ensure(bridge, restarted, epoch);
            check();
            seenRunning(epoch);
          }),
        ])
          .catch((error) => {
            if (generation === epoch)
              refreshFailure = { generation: epoch, error };
            throw error;
          })
          .finally(() => {
            settled = true;
            clearTimeout(timer);
            if (refreshing === entry) refreshing = undefined;
          }),
      };
      refreshing = entry;
      return entry.promise;
    },
    async request<T>(path: string, body?: unknown): Promise<T> {
      if (!path.startsWith("/") || path.startsWith("//"))
        throw new Error(options.messages.invalidPath);
      const epoch = generation;
      // Do not dispatch under the new generation while the old runtime is restarting.
      if (refreshing?.generation === epoch) await refreshing.promise;
      current(epoch);
      if (refreshFailure?.generation === epoch) throw refreshFailure.error;
      const method = body === undefined ? "GET" : "POST";
      if (options.nativePlatform()) {
        const bridge = options.nativeBridge();
        if (bridge) {
          const ready = async (status: RuntimeStatus) => {
            await ensure(bridge, status, epoch);
            current(epoch);
            seenRunning(epoch);
          };
          const send = async (afterNotReady: boolean): Promise<T> => {
            // Awaiting readiness can yield to an account refresh before this
            // invocation, including when retrying an undispatched request.
            current(epoch);
            let response: RuntimeJsonResponse;
            try {
              response = await bridge.request({
                path,
                method,
                ...(body === undefined ? {} : { body }),
              });
            } catch (error) {
              forget(epoch);
              // Undispatched (reuse only): wait for the runtime once, then send it
              // for the first time. An unavailable runtime is not started.
              if (
                !options.reuseRunningStatus ||
                afterNotReady ||
                !notReady(error)
              )
                throw error;
              current(epoch);
              const status = await bridge.status();
              current(epoch);
              if (!status.available) throw error;
              await ready(status);
              return send(true);
            }
            if (response.status === 503) forget(epoch);
            current(epoch);
            return result<T>(response);
          };
          if (running === epoch) return send(false);
          const status = await bridge.status();
          current(epoch);
          if (status.available) {
            await ready(status);
            return send(false);
          }
        }
        let response: RuntimeJsonResponse;
        try {
          response = await options.nativeFallback(path, body);
        } catch {
          throw new Error(options.messages.fallback);
        }
        current(epoch);
        return result<T>(response);
      }
      const response = await (
        options.webTransport ?? fetchAgentTransport
      ).request(options.webUrl(path), {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error(options.messages.invalidJson);
      }
      current(epoch);
      return result<T>({ status: response.status, data });
    },
  };
}
