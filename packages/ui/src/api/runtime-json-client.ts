/** JSON-only product runtime client. Hosts choose bridges, URLs, budgets and copy.
 * An available native runtime owns the request: its failures never select HTTP.
 * No credentials, retries or request replay are introduced here.
 */
import {
  type AgentRequestTransport,
  fetchAgentTransport,
} from "./transport.ts";
export interface RuntimeStatus {
  available: boolean;
  state: string;
  error?: string;
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
  }): Promise<RuntimeJsonResponse>;
}
export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
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
      const data = response.data as { error?: unknown; code?: unknown } | null;
      throw new RuntimeRequestError(
        typeof data?.error === "string" ? data.error : options.messages.request,
        response.status,
        typeof data?.code === "string" ? data.code : undefined,
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
          const status = await bridge.status();
          current(epoch);
          if (status.available) {
            await ensure(bridge, status, epoch);
            current(epoch);
            const response = await bridge.request({
              path,
              method,
              ...(body === undefined ? {} : { body }),
            });
            current(epoch);
            return result<T>(response);
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
