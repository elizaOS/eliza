import { buildHetznerMockApp } from "./server";
import { HetznerStore } from "./store";

export { HetznerStore } from "./store";
export { buildHetznerMockApp } from "./server";
export type { HetznerMockAppOptions } from "./server";
export * from "./types";

export interface StartHetznerMockOptions {
  /** Listen port. 0 (default) auto-assigns a free port. */
  port?: number;
  /** Listen hostname. Defaults to `127.0.0.1`. */
  hostname?: string;
  /** Action lifecycle duration in ms. Default 2000. */
  actionMs?: number;
}

export interface RunningHetznerMock {
  /** Stop the underlying Bun server. */
  stop(): Promise<void>;
  /** Base URL including `/v1` prefix — drop-in for `HCLOUD_API_BASE_URL`. */
  url: string;
  /** The bound port. */
  port: number;
  /** Shared store handle for assertions in tests. */
  store: HetznerStore;
}

/**
 * Start the Hetzner mock as a real HTTP server bound to a port.
 * Mounts the Hono app under `/v1` so it matches the real Hetzner API path layout.
 */
export async function startHetznerMock(
  options: StartHetznerMockOptions = {},
): Promise<RunningHetznerMock> {
  const { app, store } = buildHetznerMockApp({ actionMs: options.actionMs });
  // Wrap under /v1 so `HCLOUD_API_BASE_URL=<url>` works directly.
  const root = new Hono();
  root.route("/v1", app);

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: root.fetch,
  });

  return {
    stop: async () => {
      await server.stop(true);
    },
    url: `http://${server.hostname}:${server.port}/v1`,
    port: server.port,
    store,
  };
}

// local import to keep top of file tidy
import { Hono } from "hono";
