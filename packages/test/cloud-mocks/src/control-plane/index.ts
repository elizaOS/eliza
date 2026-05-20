import { buildControlPlaneApp, type ControlPlaneMockOptions } from "./server";
import type { ControlPlaneStore } from "./store";
import { startFetchServer } from "../fetch-server";

export type { ControlPlaneMockOptions } from "./server";
export { buildControlPlaneApp } from "./server";
export type { Job, JobStatus, JobType, Sandbox, SandboxStatus } from "./store";
export { ControlPlaneStore } from "./store";

export interface StartControlPlaneMockOptions
  extends Omit<ControlPlaneMockOptions, "hetznerUrl"> {
  /** Listen port. 0 = auto. */
  port?: number;
  /** Listen hostname. Default 127.0.0.1. */
  hostname?: string;
  /** Hetzner mock base URL (with `/v1`). Falls back to `HCLOUD_API_BASE_URL`. */
  hetznerUrl?: string;
  /** Background tick interval. 0 disables auto-tick (test mode). */
  tickMs?: number;
}

export interface RunningControlPlaneMock {
  stop(): Promise<void>;
  url: string;
  port: number;
  store: ControlPlaneStore;
  tick(
    limit?: number,
  ): Promise<{ processed: number; failed: number; skipped: number }>;
  cleanupStuck(): Promise<{ failed: number }>;
}

export async function startControlPlaneMock(
  options: StartControlPlaneMockOptions = {},
): Promise<RunningControlPlaneMock> {
  const hetznerUrl =
    options.hetznerUrl ??
    process.env.HCLOUD_API_BASE_URL ??
    "https://api.hetzner.cloud/v1";

  const { app, store, tick, cleanupStuck } = buildControlPlaneApp({
    ...options,
    hetznerUrl,
  });

  const server = await startFetchServer(app.fetch, {
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
  });
  const port = server.port;
  if (typeof port !== "number") {
    throw new Error("Control plane mock server did not bind to a numeric port");
  }

  const tickMs = options.tickMs ?? 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  if (tickMs > 0) {
    interval = setInterval(() => {
      tick().catch(() => {
        /* swallowed; surfaced via job state */
      });
    }, tickMs);
  }

  return {
    stop: async () => {
      if (interval) clearInterval(interval);
      await server.stop(true);
    },
    url: `http://${server.hostname}:${port}`,
    port,
    store,
    tick,
    cleanupStuck,
  };
}
