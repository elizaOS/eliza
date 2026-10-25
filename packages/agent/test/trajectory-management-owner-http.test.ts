/** Real Node HTTP boundary for the owner-only trajectory management routes: the server.ts gate, lazy dispatch and registered service together. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type TrajectoriesService,
  trajectoriesPlugin,
} from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { registerTokenRoleResolver } from "../src/api/boundary-role-resolver.ts";
import { startApiServer } from "../src/api/server.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let service: TrajectoriesService;
let unregisterResolver: (() => void) | undefined;
let stateDir: string;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-trajectory-owner-http-"));
  await writeFile(path.join(stateDir, "eliza.json"), "{}");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "1");
  vi.stubEnv("ELIZA_DISABLE_TRAJECTORY_LOGGING", undefined);
  fixture = await createTestRuntime({
    characterName: "TrajectoryOwnerHttp",
    plugins: [trajectoriesPlugin],
  });
  await fixture.runtime.getServiceLoadPromise("trajectories");
  const registered =
    fixture.runtime.getService<TrajectoriesService>("trajectories");
  if (!registered) throw new Error("Trajectory service did not start");
  service = registered;
  unregisterResolver = registerTokenRoleResolver({
    id: "trajectory-owner-http-test",
    resolve: (req) => {
      const token = req.headers["x-test-role"];
      if (token !== "owner" && token !== "user") return null;
      return {
        providerId: "trajectory-owner-http-test",
        worldRole: token === "owner" ? "OWNER" : "USER",
        principal: `trajectory-${token}`,
        isAdmin: token === "owner",
        isRouteInScope: () => true,
        claims: {},
      };
    },
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  unregisterResolver?.();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}, 120_000);

function request(
  role: "owner" | "user",
  route: string,
  method: string,
  body?: object,
) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      "x-test-role": role,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

it("refuses every management route to a non-owner before the service is touched", async () => {
  const before = service.isEnabled();
  const clearAll = vi.spyOn(service, "clearAllTrajectories");
  const deleteSome = vi.spyOn(service, "deleteTrajectories");
  const exportRows = vi.spyOn(service, "exportTrajectories");
  for (const [method, route, body] of [
    ["GET", "/api/trajectories/config"],
    ["PUT", "/api/trajectories/config", { enabled: !before }],
    ["POST", "/api/trajectories/export", { format: "json" }],
    ["DELETE", "/api/trajectories", { clearAll: true }],
    ["DELETE", "/api/trajectories", { trajectoryIds: ["any"] }],
  ] as const) {
    const response = await request("user", route, method, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Owner role required" });
  }
  expect(service.isEnabled()).toBe(before);
  expect(clearAll).not.toHaveBeenCalled();
  expect(deleteSome).not.toHaveBeenCalled();
  expect(exportRows).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("serves the owner through the real server dispatch", async () => {
  const config = await request("owner", "/api/trajectories/config", "GET");
  expect(config.status).toBe(200);
  expect(await config.json()).toEqual({ enabled: service.isEnabled() });

  const toggled = await request("owner", "/api/trajectories/config", "PUT", {
    enabled: false,
  });
  expect(toggled.status).toBe(200);
  expect(await toggled.json()).toEqual({ enabled: false });
  expect(service.isEnabled()).toBe(false);
  service.setEnabled(true);

  const exported = await request("owner", "/api/trajectories/export", "POST", {
    format: "json",
  });
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-disposition")).toContain("attachment");

  expect(
    (await request("owner", "/api/trajectories", "DELETE", {})).status,
  ).toBe(400);
  const cleared = await request("owner", "/api/trajectories", "DELETE", {
    clearAll: true,
  });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({ deleted: 0 });
});
