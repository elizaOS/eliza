/**
 * Agent-token minting route — service-secret compare must be constant-time
 * (#12227 M1). The route mints Steward agent JWTs for any `agentId`, so a
 * timing oracle on the service-secret compare could recover
 * ELIZA_CLOUD_SERVICE_TOKEN / AGENT_TOKEN_SERVICE_TOKEN and forge tokens. The
 * `===` was replaced with `timingSafeEqualSecret`; these drive the real route.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const mintAgentToken = mock(async (agentId: string) => ({
  token: `jwt-for-${agentId}`,
  expiresAt: "2026-01-01T00:00:00Z",
}));
const getCurrentUser = mock(async () => null);

mock.module("@/lib/auth/agent-token", () => ({ mintAgentToken }));
mock.module("@/lib/auth/workers-hono-auth", () => ({ getCurrentUser }));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: agentTokensRoute } = await import("./route");

const SECRET = "super-secret-service-token-value";
const ENV = { ELIZA_CLOUD_SERVICE_TOKEN: SECRET };

function post(headers: Record<string, string>) {
  const app = new Hono();
  app.route("/api/v1/agent-tokens", agentTokensRoute);
  return app.fetch(
    new Request("https://api.example.test/api/v1/agent-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ agentId: "agent-xyz" }),
    }),
    ENV,
  );
}

describe("agent-tokens route — constant-time service-secret gate (M1)", () => {
  beforeEach(() => {
    mintAgentToken.mockClear();
    getCurrentUser.mockClear();
  });

  test("the source has no plain === / !== secret comparison", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./route.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("timingSafeEqualSecret");
    expect(src).not.toMatch(/supplied\s*===\s*expected/);
    expect(src).not.toMatch(/supplied\s*!==\s*expected/);
  });

  test("the exact service token mints a JWT", async () => {
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: "jwt-for-agent-xyz",
    });
    expect(mintAgentToken).toHaveBeenCalledTimes(1);
  });

  test("a 1-byte-off service token is rejected 401 and mints nothing", async () => {
    const oneOff = `${SECRET.slice(0, -1)}X`;
    const res = await post({ authorization: `Bearer ${oneOff}` });
    expect(res.status).toBe(401);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });

  test("a length-mismatched token is rejected 401 (no timingSafeEqual throw)", async () => {
    const res = await post({ "x-eliza-service-token": `${SECRET}extra` });
    expect(res.status).toBe(401);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });

  test("an absent token is rejected 401", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });
});
