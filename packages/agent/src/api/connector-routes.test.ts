/**
 * Coverage for `handleConnectorRoutes` config persistence. Drives the real
 * handler with an in-memory harness whose `saveElizaConfig` throws, asserting
 * that a failed disk write is surfaced as a 500 and the in-memory connector
 * config (and legacy `channels` mirror) is rolled back — never reported as a
 * successful update.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorRouteContext } from "./connector-routes";
import { handleConnectorRoutes } from "./connector-routes";

type CapturedResponse = {
  status: number;
  body: unknown;
};

function createHarness(options: {
  method: string;
  pathname: string;
  body?: Record<string, unknown>;
  state?: ConnectorRouteContext["state"];
  saveElizaConfig?: ConnectorRouteContext["saveElizaConfig"];
  onConnectorDisconnect?: ConnectorRouteContext["onConnectorDisconnect"];
}) {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const state: ConnectorRouteContext["state"] = options.state ?? {
    config: { connectors: {} },
  };
  const ctx: ConnectorRouteContext = {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    method: options.method,
    pathname: options.pathname,
    state,
    json: (_res, data, status = 200) => {
      captured.status = status;
      captured.body = data;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    readJsonBody: async <T extends object>() => (options.body ?? {}) as T,
    saveElizaConfig: options.saveElizaConfig ?? vi.fn(),
    redactConfigSecrets: (value) => value,
    isBlockedObjectKey: (key) =>
      key === "__proto__" || key === "constructor" || key === "prototype",
    cloneWithoutBlockedObjectKeys: (value) => value,
    onConnectorDisconnect: options.onConnectorDisconnect,
  };

  return { ctx, captured, state };
}

describe("connector routes", () => {
  it("does not report connector updates as successful when config persistence fails", async () => {
    const saveElizaConfig = vi.fn(() => {
      throw new Error("disk denied");
    });
    const { ctx, captured, state } = createHarness({
      method: "POST",
      pathname: "/api/connectors",
      body: { name: "slack", config: { enabled: true } },
      saveElizaConfig,
    });

    await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({
      error: "Failed to save connector config: disk denied",
    });
    expect(state.config.connectors).toEqual({});
  });

  it("rolls back connector deletion when config persistence fails", async () => {
    const saveElizaConfig = vi.fn(() => {
      throw new Error("disk denied");
    });
    const onConnectorDisconnect = vi.fn();
    const config: ConnectorRouteContext["state"]["config"] = {
      connectors: { slack: { enabled: true } },
    };
    (config as Record<string, unknown>).channels = { slack: { enabled: true } };
    const { ctx, captured, state } = createHarness({
      method: "DELETE",
      pathname: "/api/connectors/slack",
      state: { config },
      saveElizaConfig,
      onConnectorDisconnect,
    });

    await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({
      error: "Failed to save connector config: disk denied",
    });
    expect(state.config.connectors).toEqual({ slack: { enabled: true } });
    expect((state.config as Record<string, unknown>).channels).toEqual({
      slack: { enabled: true },
    });
    expect(onConnectorDisconnect).not.toHaveBeenCalled();
  });

  // ── #14415 observability: disconnect-path failures must be reported ──────
  it("reports (not swallows) a disconnect event-bus failure on DELETE", async () => {
    const reportError = vi.fn();
    const runtime = {
      agentId: "agent-1",
      emitEvent: vi.fn(() => Promise.reject(new Error("event bus down"))),
      reportError,
    } as unknown as NonNullable<ConnectorRouteContext["state"]["runtime"]>;
    const config: ConnectorRouteContext["state"]["config"] = {
      connectors: { slack: { enabled: true } },
    };
    const { ctx, captured } = createHarness({
      method: "DELETE",
      pathname: "/api/connectors/slack",
      state: { config, runtime },
      saveElizaConfig: vi.fn(),
    });

    await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);

    // The response still succeeds — a broken event bus must not block the
    // disconnect (fail-open on the response, per the existing contract) …
    expect(captured.status).toBe(200);
    // … but the failure is now observable via reportError instead of a silent
    // empty catch, with structured context identifying the connector + op.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "connector.disconnect.emitEvent",
      expect.any(Error),
      expect.objectContaining({ connector: "slack", op: "DELETE" }),
    );
  });

  it("reports (not swallows) a host disconnect-callback failure on POST enabled:false", async () => {
    const reportError = vi.fn();
    const runtime = {
      agentId: "agent-1",
      emitEvent: vi.fn(() => Promise.resolve()),
      reportError,
    } as unknown as NonNullable<ConnectorRouteContext["state"]["runtime"]>;
    const onConnectorDisconnect = vi.fn(() => {
      throw new Error("cache purge failed");
    });
    const { ctx, captured } = createHarness({
      method: "POST",
      pathname: "/api/connectors",
      body: { name: "slack", config: { enabled: false } },
      state: { config: { connectors: { slack: { enabled: true } } }, runtime },
      saveElizaConfig: vi.fn(),
      onConnectorDisconnect,
    });

    await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(reportError).toHaveBeenCalledWith(
      "connector.disconnect.hostCallback",
      expect.any(Error),
      expect.objectContaining({ connector: "slack", op: "POST-disconnect" }),
    );
  });
});
