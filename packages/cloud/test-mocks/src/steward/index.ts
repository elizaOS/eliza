/** Stateful loopback mock for Steward platform-user lifecycle operations. */

import { Hono } from "hono";
import { startFetchServer } from "../fetch-server";

export type StewardMockUserState = "active" | "deactivated" | "deleted";

export interface RunningStewardMock {
  stop(): Promise<void>;
  url: string;
  port: number;
  users: Map<string, StewardMockUserState>;
}

export async function startStewardMock(
  options: { port?: number; hostname?: string; platformKey?: string } = {},
): Promise<RunningStewardMock> {
  const users = new Map<string, StewardMockUserState>();
  const platformKey = options.platformKey ?? "steward-e2e-platform-key";
  const app = new Hono();

  app.use("/platform/*", async (c, next) => {
    if (c.req.header("x-steward-platform-key") !== platformKey) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.patch("/platform/users/:id/deactivate", (c) => {
    const userId = c.req.param("id");
    users.set(userId, "deactivated");
    return c.json({ ok: true, data: { userId } });
  });

  app.delete("/platform/users/:id", (c) => {
    const userId = c.req.param("id");
    users.set(userId, "deleted");
    return c.json({ ok: true, data: { userId } });
  });

  const server = await startFetchServer(app.fetch, {
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
  });

  return {
    stop: () => server.stop(),
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    users,
  };
}
