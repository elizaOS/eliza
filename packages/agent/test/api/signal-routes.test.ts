import { describe, expect, test, vi } from "vitest";
import type {
  SignalRouteDeps,
  SignalRouteState,
} from "../../src/api/signal-routes";
import { handleSignalRoute } from "../../src/api/signal-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildState(
  overrides: Partial<SignalRouteState> = {},
): SignalRouteState {
  return {
    signalPairingSessions: new Map(),
    broadcastWs: vi.fn(),
    config: {},
    runtime: undefined,
    saveConfig: vi.fn(),
    workspaceDir: "/tmp/test-workspace",
    ...overrides,
  };
}

function buildDeps(overrides: Partial<SignalRouteDeps> = {}): SignalRouteDeps {
  return {
    sanitizeAccountId: vi.fn((id: string) => id),
    signalAuthExists: vi.fn(() => false),
    signalLogout: vi.fn(),
    createSignalPairingSession: vi.fn(() => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      getStatus: vi.fn(() => "pairing"),
    })),
    ...overrides,
  };
}

describe("handleSignalRoute", () => {
  test("returns false for unrelated path", async () => {
    const req = createMockIncomingMessage({ method: "GET", url: "/api/other" });
    const { res } = createMockHttpResponse();
    const state = buildState();
    const deps = buildDeps();

    const handled = await handleSignalRoute(
      req,
      res,
      "/api/other",
      "GET",
      state,
      deps,
    );

    expect(handled).toBe(false);
  });

  test("POST /api/signal/pair creates a pairing session", async () => {
    const req = createMockIncomingMessage({
      method: "POST",
      url: "/api/signal/pair",
      body: JSON.stringify({ accountId: "test-account" }),
      headers: { host: "localhost:2138", "content-type": "application/json" },
    });
    const { res, getStatus, getJson } = createMockHttpResponse();
    const state = buildState();
    const deps = buildDeps();

    const handled = await handleSignalRoute(
      req,
      res,
      "/api/signal/pair",
      "POST",
      state,
      deps,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    const json = getJson<{ ok: boolean; accountId: string }>();
    expect(json.ok).toBe(true);
  });

  test("POST /api/signal/pair returns 400 when sanitizeAccountId throws", async () => {
    const req = createMockIncomingMessage({
      method: "POST",
      url: "/api/signal/pair",
      body: JSON.stringify({ accountId: "" }),
      headers: { host: "localhost:2138", "content-type": "application/json" },
    });
    const { res, getStatus, getJson } = createMockHttpResponse();
    const state = buildState();
    const deps = buildDeps({
      sanitizeAccountId: vi.fn(() => {
        throw new Error("Invalid account ID");
      }),
    });

    const handled = await handleSignalRoute(
      req,
      res,
      "/api/signal/pair",
      "POST",
      state,
      deps,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(400);
    expect(getJson<{ error: string }>().error).toBe("Invalid account ID");
  });
});
