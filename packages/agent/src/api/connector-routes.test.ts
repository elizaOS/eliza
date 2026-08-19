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

  it("reports (not swallows) a host disconnect-callback failure on POST enabled:false", async () => {
    const reportError = vi.fn();
    const runtime = {
      agentId: "agent-1",
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

  it("DELETE /api/connectors/:name returns 400 on malformed percent-encoded name", async () => {
    const saveElizaConfig = vi.fn();
    const onConnectorDisconnect = vi.fn();
    for (const badName of ["%", "%2", "%ZZ", "%E0%A4"]) {
      const { ctx, captured } = createHarness({
        method: "DELETE",
        pathname: `/api/connectors/${badName}`,
        saveElizaConfig,
        onConnectorDisconnect,
      });
      await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({
        error: "Invalid connector name encoding",
      });
    }
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(onConnectorDisconnect).not.toHaveBeenCalled();
  });

  it("preserves encoded connector-name separators without crossing route boundaries", async () => {
    const saveElizaConfig = vi.fn();
    const onConnectorDisconnect = vi.fn();
    const config: ConnectorRouteContext["state"]["config"] = {
      connectors: {
        "slack/accounts": { enabled: true },
        "slack\\accounts": { enabled: true },
      },
    };

    for (const encodedName of ["slack%2Faccounts", "slack%5Caccounts"]) {
      const { ctx, captured } = createHarness({
        method: "DELETE",
        pathname: `/api/connectors/${encodedName}`,
        state: { config },
        saveElizaConfig,
        onConnectorDisconnect,
      });
      await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);
      expect(captured.status).toBe(200);
    }

    expect(config.connectors).toEqual({});
    expect(saveElizaConfig).toHaveBeenCalledTimes(2);
    expect(onConnectorDisconnect).toHaveBeenNthCalledWith(1, "slack/accounts");
    expect(onConnectorDisconnect).toHaveBeenNthCalledWith(2, "slack\\accounts");
  });

  it("rejects encoded blocked object keys before deletion side effects", async () => {
    const saveElizaConfig = vi.fn();
    const onConnectorDisconnect = vi.fn();
    for (const badName of [
      "%5F%5Fproto%5F%5F",
      "%63onstructor",
      "%70rototype",
    ]) {
      const { ctx, captured } = createHarness({
        method: "DELETE",
        pathname: `/api/connectors/${badName}`,
        saveElizaConfig,
        onConnectorDisconnect,
      });
      await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({
        error: "Missing or invalid connector name",
      });
    }
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(onConnectorDisconnect).not.toHaveBeenCalled();
  });

  it("DELETE /api/connectors/:name decodes valid percent-encoded connector name", async () => {
    const config: ConnectorRouteContext["state"]["config"] = {
      connectors: { "custom-connector": { enabled: true } },
    };
    const { ctx, captured, state } = createHarness({
      method: "DELETE",
      pathname: "/api/connectors/custom%2Dconnector",
      state: { config },
    });
    await expect(handleConnectorRoutes(ctx)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    expect(state.config.connectors?.["custom-connector"]).toBeUndefined();
  });
});
