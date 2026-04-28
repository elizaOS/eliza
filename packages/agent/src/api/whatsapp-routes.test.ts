import type http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleWhatsAppRoute,
  type WhatsAppPairingEventLike,
  type WhatsAppRouteDeps,
  type WhatsAppRouteState,
} from "./whatsapp-routes.js";

function makeReq(url: string, body: unknown): http.IncomingMessage {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const req = {
    url,
    headers: { host: "localhost" },
    on(event: string, fn: (arg?: unknown) => void) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(fn);
      handlers.set(event, listeners);
      return req;
    },
    off(event: string, fn: (arg?: unknown) => void) {
      const listeners = handlers.get(event) ?? [];
      handlers.set(
        event,
        listeners.filter((listener) => listener !== fn),
      );
      return req;
    },
    destroy: vi.fn(),
  } as unknown as http.IncomingMessage;

  setImmediate(() => {
    const chunk = Buffer.from(JSON.stringify(body), "utf-8");
    handlers.get("data")?.forEach((fn) => {
      fn(chunk);
    });
    handlers.get("end")?.forEach((fn) => {
      fn();
    });
  });

  return req;
}

function makeResponseCollector() {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    headers,
    readBody<T>() {
      return JSON.parse(body) as T;
    },
    getStatus() {
      return res.statusCode;
    },
  };
}

function makeState(config: WhatsAppRouteState["config"]): WhatsAppRouteState {
  return {
    whatsappPairingSessions: new Map(),
    broadcastWs: vi.fn(),
    config,
    saveConfig: vi.fn(),
    workspaceDir: "/tmp/milady-whatsapp-route-test",
  };
}

function makeDeps(
  eventFactory?: (accountId: string) => WhatsAppPairingEventLike,
): WhatsAppRouteDeps {
  const createWhatsAppPairingSession = vi.fn<
    WhatsAppRouteDeps["createWhatsAppPairingSession"]
  >(({ accountId, onEvent }) => {
    const status = eventFactory?.(accountId).status ?? "idle";
    return {
      start: vi.fn(async () => {
        const event = eventFactory?.(accountId);
        if (event) {
          onEvent(event);
        }
      }),
      stop: vi.fn(),
      getStatus: vi.fn(() => status ?? "idle"),
    };
  });

  return {
    sanitizeAccountId: (accountId) => accountId,
    whatsappAuthExists: vi.fn(() => false),
    whatsappLogout: vi.fn(async () => {}),
    createWhatsAppPairingSession,
  };
}

describe("WhatsApp pairing routes", () => {
  it("can pair for LifeOps without enabling the platform WhatsApp plugin", async () => {
    const existingConnectorConfig = {
      authDir: "/tmp/existing-whatsapp-auth",
      enabled: false,
    };
    const config = {
      connectors: { whatsapp: existingConnectorConfig },
    } as WhatsAppRouteState["config"];
    const state = makeState(config);
    const deps = makeDeps((accountId) => ({
      type: "whatsapp-status",
      accountId,
      status: "connected",
      phoneNumber: "15551234567",
    }));
    const { res, readBody, getStatus } = makeResponseCollector();

    const handled = await handleWhatsAppRoute(
      makeReq("/api/whatsapp/pair", {
        accountId: "default",
        authScope: "lifeops",
        configurePlugin: false,
      }),
      res,
      "/api/whatsapp/pair",
      "POST",
      state,
      deps,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(readBody<{ ok: boolean }>().ok).toBe(true);
    expect(deps.createWhatsAppPairingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authDir: path.join(
          state.workspaceDir,
          "lifeops-whatsapp-auth",
          "default",
        ),
      }),
    );
    expect(config.connectors?.whatsapp).toEqual(existingConnectorConfig);
    expect(
      (
        state.config as {
          agents?: {
            defaults?: {
              ownerContacts?: Record<string, { channelId?: string }>;
            };
          };
        }
      ).agents?.defaults?.ownerContacts?.whatsapp?.channelId,
    ).toBe("15551234567");
    expect(state.saveConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps default pairing behavior for the platform WhatsApp plugin", async () => {
    const config = { connectors: {} } as WhatsAppRouteState["config"];
    const state = makeState(config);
    const deps = makeDeps((accountId) => ({
      type: "whatsapp-status",
      accountId,
      status: "connected",
    }));
    const { res } = makeResponseCollector();

    await handleWhatsAppRoute(
      makeReq("/api/whatsapp/pair", { accountId: "default" }),
      res,
      "/api/whatsapp/pair",
      "POST",
      state,
      deps,
    );

    expect(config.connectors?.whatsapp).toEqual({
      authDir: path.join(state.workspaceDir, "whatsapp-auth", "default"),
      enabled: true,
    });
    expect(state.saveConfig).toHaveBeenCalledTimes(1);
  });

  it("can disconnect LifeOps QR auth without deleting platform plugin config", async () => {
    const existingConnectorConfig = {
      authDir: "/tmp/existing-whatsapp-auth",
      enabled: false,
    };
    const config = {
      connectors: { whatsapp: existingConnectorConfig },
    } as WhatsAppRouteState["config"];
    const state = makeState(config);
    const deps = makeDeps();
    const { res, readBody } = makeResponseCollector();

    const handled = await handleWhatsAppRoute(
      makeReq("/api/whatsapp/disconnect", {
        accountId: "default",
        authScope: "lifeops",
        configurePlugin: false,
      }),
      res,
      "/api/whatsapp/disconnect",
      "POST",
      state,
      deps,
    );

    expect(handled).toBe(true);
    expect(readBody<{ ok: boolean }>().ok).toBe(true);
    expect(config.connectors?.whatsapp).toEqual(existingConnectorConfig);
    expect(deps.whatsappLogout).not.toHaveBeenCalled();
    expect(state.saveConfig).not.toHaveBeenCalled();
  });
});
