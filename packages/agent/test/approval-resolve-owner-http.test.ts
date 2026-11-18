/** Real Node HTTP boundary for POST /api/approvals/:id/resolve: the server.ts owner gate and lazy dispatch together. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { registerTokenRoleResolver } from "../src/api/boundary-role-resolver.ts";
import { startApiServer } from "../src/api/server.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let unregisterResolver: (() => void) | undefined;
let stateDir: string;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-approval-owner-http-"));
  await writeFile(path.join(stateDir, "eliza.json"), "{}");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({ characterName: "ApprovalOwnerHttp" });
  unregisterResolver = registerTokenRoleResolver({
    id: "approval-owner-http-test",
    resolve: (req) => {
      const token = req.headers["x-test-role"];
      if (token !== "owner" && token !== "user") return null;
      return {
        providerId: "approval-owner-http-test",
        worldRole: token === "owner" ? "OWNER" : "USER",
        principal: `approval-${token}`,
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

function resolve(role: "owner" | "user", body: object) {
  return fetch(`http://127.0.0.1:${server.port}/api/approvals/review/resolve`, {
    method: "POST",
    headers: { "x-test-role": role, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("refuses a non-owner before the approval is read", async () => {
  const response = await resolve("user", {
    decision: "approve",
    revision: "any",
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Owner role required" });
});

it("dispatches the owner to the resolve route", async () => {
  const response = await resolve("owner", { decision: "approve" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "decision and revision are required",
  });
});
