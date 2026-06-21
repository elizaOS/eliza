/**
 * Route-level e2e for plugin-telegram (issue #8802).
 *
 * Boots the plugin's declared `Route[]` (`telegramSetupRoutes` +
 * `telegramAccountRoutes`) through the real production dispatcher
 * (`tryHandleRuntimePluginRoute`) over a loopback `http.createServer` —
 * exercising the real auth gate, JSON body parsing, query parsing, and handler
 * dispatch — with a faked `connector-setup` service standing in for the only
 * runtime dependency the deterministic branches touch.
 *
 * No mocked `json`/`error` helpers and no shape-only assertions: every check is
 * against a real HTTP response decoded from the wire. Telegram Bot-API / GramJS
 * network paths (valid bot token → `getMe`, phone → provisioning code) are
 * intentionally never reached, so the suite stays hermetic and offline.
 *
 * The package's global `__tests__/core-test-mock.ts` replaces `@elizaos/core`
 * with a partial stub that omits the HTTP utilities the dispatcher imports
 * (`readRequestBodyBuffer`, `isJsonObjectBody`, `writeJsonError`,
 * `setRuntimeRouteHostContext`). This file re-mocks `@elizaos/core` back to the
 * real module so the dispatcher and route handlers run against production code.
 */

import { vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await vi.importActual("@elizaos/core");
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { telegramAccountRoutes } from "./account-setup-routes.ts";
import { telegramSetupRoutes } from "./setup-routes.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

type ConnectorConfig = Record<string, unknown>;

interface FakeSetupServiceState {
  config: ConnectorConfig;
  calls: string[];
}

/**
 * Faked `connector-setup` service. Implements every method the route guards
 * (`isConnectorSetupService` in both route modules) require, backed by a plain
 * mutable config object so `updateConfig` mutations are observable.
 */
function makeSetupService(state: FakeSetupServiceState) {
  return {
    getConfig: () => state.config,
    persistConfig: (config: ConnectorConfig) => {
      state.calls.push("persistConfig");
      state.config = config;
    },
    updateConfig: (updater: (config: ConnectorConfig) => void) => {
      state.calls.push("updateConfig");
      updater(state.config);
    },
    registerEscalationChannel: (channel: string) => {
      state.calls.push(`registerEscalationChannel:${channel}`);
      return true;
    },
    setOwnerContact: (update: { source: string }) => {
      state.calls.push(`setOwnerContact:${update.source}`);
      return true;
    },
  };
}

function makeRuntime(
  options: { withService?: boolean; state?: FakeSetupServiceState } = {},
): AgentRuntime {
  const { withService = true, state } = options;
  const setupState: FakeSetupServiceState = state ?? {
    // Shape a real connector-setup service returns: a `connectors` block with a
    // present-but-empty `telegram` sub-config (no saved token yet).
    config: { connectors: { telegram: {} } },
    calls: [],
  };
  const setupService = makeSetupService(setupState);
  return {
    routes: [...telegramSetupRoutes, ...telegramAccountRoutes],
    // Only the `connector-setup` service exists in these branches. The live
    // `telegram` / `telegram-account` services are absent (null), which is the
    // state a freshly-configuring user is in.
    getService: (key: string) =>
      withService && key === "connector-setup" ? setupService : null,
    // No persisted env settings — keeps the missing-phone / missing-token
    // validation branches deterministic.
    getSetting: () => null,
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface SetupErrorBody {
  error: { code: string; message: string };
}

describe("plugin-telegram setup routes (real dispatch)", () => {
  it("serves bot-token status on a happy path (200, idle when nothing configured)", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: { hasToken: boolean; serviceConnected: boolean };
    };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
    expect(body.detail.hasToken).toBe(false);
    expect(body.detail.serviceConnected).toBe(false);
  });

  it("rejects a start with no token (400 from the real validator)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram/start", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("token is required");
  });

  it("rejects a start with a malformed token (400 format invalid)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram/start", {
      token: "not-a-real-token",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("Token format invalid");
  });

  it("cancels bot-token setup on a happy path (200, clears persisted token)", async () => {
    const state: FakeSetupServiceState = {
      config: { connectors: { telegram: { botToken: "123:abc" } } },
      calls: [],
    };
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/setup/telegram/cancel", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
    expect(state.calls).toContain("updateConfig");
    const connectors = state.config.connectors as Record<
      string,
      Record<string, unknown>
    >;
    expect(connectors.telegram.botToken).toBeUndefined();
  });

  it("still serves status when the connector-setup service is unavailable (200)", async () => {
    // Telegram setup has no 503 branch — without the connector-setup service it
    // degrades to runtime-only reads, so status must still resolve.
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
  });

  it("enforces the auth gate on the non-public bot-token routes (401)", async () => {
    const base = await startServer(makeRuntime(), () => false);

    const status = await fetch(`${base}/api/setup/telegram/status`);
    expect(status.status).toBe(401);
    expect((await status.json()) as { error: string }).toEqual({
      error: "Unauthorized",
    });

    const start = await postJson(base, "/api/setup/telegram/start", {
      token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    expect(start.status).toBe(401);

    const cancel = await postJson(base, "/api/setup/telegram/cancel", {});
    expect(cancel.status).toBe(401);
  });
});

describe("plugin-telegram account routes (real dispatch)", () => {
  it("serves account auth status on a happy path (200, idle)", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/setup/telegram-account/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: { status: string; configured: boolean };
    };
    expect(body.connector).toBe("telegram-account");
    expect(body.state).toBe("idle");
    expect(body.detail.status).toBe("idle");
    expect(body.detail.configured).toBe(false);
  });

  it("rejects an account start with no phone (400)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram-account/start", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("phone number is required");
  });

  it("rejects submit-code before a login session has started (400)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(
      base,
      "/api/setup/telegram-account/submit-code",
      { telegramCode: "12345" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("login session has not been started");
  });

  it("cancels account auth on a happy path (200)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram-account/cancel", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram-account");
    expect(body.state).toBe("idle");
  });

  it("enforces the auth gate on the non-public account routes (401)", async () => {
    const base = await startServer(makeRuntime(), () => false);

    const status = await fetch(`${base}/api/setup/telegram-account/status`);
    expect(status.status).toBe(401);

    const start = await postJson(base, "/api/setup/telegram-account/start", {
      phone: "+15555550100",
    });
    expect(start.status).toBe(401);

    const submit = await postJson(
      base,
      "/api/setup/telegram-account/submit-code",
      { telegramCode: "12345" },
    );
    expect(submit.status).toBe(401);

    const cancel = await postJson(
      base,
      "/api/setup/telegram-account/cancel",
      {},
    );
    expect(cancel.status).toBe(401);
  });
});
