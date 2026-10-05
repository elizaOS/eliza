/**
 * A failed first-run commit must roll back its own config and environment
 * writes even when no direct provider account was adopted. The loopback
 * `/api/config` sync runs after `saveElizaConfig`, so a sync failure used to
 * leave `meta.firstRunComplete=true` on disk and connector env applied while
 * the client received a 500.
 */
import type http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
}));

vi.mock("@elizaos/agent", () => ({
  applyCanonicalFirstRunConfig: vi.fn(),
  applyFirstRunCredentialPersistence: vi.fn(async () => null),
  loadEffectiveElizaConfig: vi.fn(() => structuredClone(store.config)),
  loadElizaConfig: vi.fn(() => structuredClone(store.config)),
  saveElizaConfig: vi.fn((config: Record<string, unknown>) => {
    store.config = structuredClone(config);
  }),
}));

vi.mock("@elizaos/host/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/host/protocol")>()),
  prepareFirstRunConnectors: vi.fn(() => ({
    ok: true,
    connectors: { test: { enabled: true } },
    env: { FIRST_RUN_ROLLBACK_TEST_TOKEN: "connector-token" },
  })),
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));

vi.mock("./deferred-runtime-boot", () => ({
  isRuntimeBootDeferred: vi.fn(() => false),
  triggerDeferredRuntimeBoot: vi.fn(),
}));

import type { CompatRuntimeState } from "./compat-route-shared";
import { handleFirstRunRoute } from "./first-run-routes";

function makeRequest(body: unknown): http.IncomingMessage {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method: "POST",
    url: "/api/first-run",
    headers: { "content-type": "application/json" },
    socket: { localPort: 31337 },
  }) as unknown as http.IncomingMessage;
  stream.end(JSON.stringify(body));
  return req;
}

function makeResponse() {
  const captured = { status: 0, body: "" };
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader: vi.fn(),
    end(chunk: string) {
      captured.status = this.statusCode;
      captured.body = chunk;
      this.headersSent = true;
    },
  };
  return { res: res as unknown as http.ServerResponse, captured };
}

describe("handleFirstRunRoute rollback", () => {
  beforeEach(() => {
    store.config = { meta: { firstRunComplete: false } };
    delete process.env.FIRST_RUN_ROLLBACK_TEST_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sync refused", { status: 500 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FIRST_RUN_ROLLBACK_TEST_TOKEN;
  });

  it("restores config, env and pending name when the loopback sync fails without an adopted account", async () => {
    const reloadConfigFromDisk = vi.fn();
    const state = {
      current: null,
      pendingAgentName: "Previous",
      reloadConfigFromDisk,
    } as unknown as CompatRuntimeState;
    const { res, captured } = makeResponse();

    await expect(
      handleFirstRunRoute(makeRequest({ name: "Ada" }), res, state),
    ).resolves.toBe(true);

    expect(captured.status).toBe(500);
    expect(JSON.parse(captured.body)).toEqual({
      error: "Failed to persist first-run state",
    });
    expect(store.config).toEqual({ meta: { firstRunComplete: false } });
    expect(process.env.FIRST_RUN_ROLLBACK_TEST_TOKEN).toBeUndefined();
    expect(state.pendingAgentName).toBe("Previous");
    expect(reloadConfigFromDisk).toHaveBeenCalledTimes(1);
  });
});
