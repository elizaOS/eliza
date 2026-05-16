import { buildControlPlaneApp, type ControlPlaneMockOptions } from "./server";
import { ControlPlaneStore } from "./store";

export { ControlPlaneStore } from "./store";
export type { Job, JobStatus, JobType, Sandbox, SandboxStatus } from "./store";
export { buildControlPlaneApp } from "./server";
export type { ControlPlaneMockOptions } from "./server";

export interface StartControlPlaneMockOptions extends Omit<ControlPlaneMockOptions, "hetznerUrl"> {
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
  tick(): Promise<{ processed: number; failed: number }>;
  cleanupStuck(): Promise<{ failed: number }>;
}

export async function startControlPlaneMock(
  options: StartControlPlaneMockOptions = {},
): Promise<RunningControlPlaneMock> {
  const hetznerUrl =
    options.hetznerUrl ?? process.env.HCLOUD_API_BASE_URL ?? "https://api.hetzner.cloud/v1";

  const { app, store, tick, cleanupStuck } = buildControlPlaneApp({
    ...options,
    hetznerUrl,
  });

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: app.fetch,
  });

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
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    store,
    tick,
    cleanupStuck,
  };
}
