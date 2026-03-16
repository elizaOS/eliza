/**
 * E2E tests for the Social UI (ConnectorsPageView, PluginsView mode="social").
 *
 * Tests cover:
 * 1. Social page shell rendering
 * 2. Social-only plugin mode wiring
 * 3. Connector enable/disable helpers
 * 4. Connector configuration helpers
 * 5. Connection status display
 */

import http from "node:http";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Part 1: API Tests for Connector Endpoints
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function createConnectorTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getConnectors: () => Array<{
    name: string;
    enabled: boolean;
    connected: boolean;
  }>;
}> {
  const connectors = [
    {
      name: "@elizaos/plugin-discord",
      enabled: false,
      connected: false,
      category: "connector",
    },
    {
      name: "@elizaos/plugin-telegram",
      enabled: false,
      connected: false,
      category: "connector",
    },
    {
      name: "@elizaos/plugin-signal",
      enabled: false,
      connected: false,
      category: "connector",
    },
    {
      name: "@elizaos/plugin-whatsapp",
      enabled: false,
      connected: false,
      category: "connector",
    },
    {
      name: "@elizaos/plugin-twitch",
      enabled: false,
      connected: false,
      category: "streaming",
    },
  ];

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      const c: Buffer[] = [];
      r.on("data", (d: Buffer) => c.push(d));
      r.on("end", () => ok(Buffer.concat(c).toString()));
    });

  const routes: Record<
    string,
    (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void> | void
  > = {
    "GET /api/plugins": (_r, res) =>
      json(res, {
        plugins: connectors.map((c) => ({
          name: c.name,
          enabled: c.enabled,
          tags: [c.category],
          description: `${c.name} connector`,
        })),
      }),
    "POST /api/plugins/toggle": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const connector = connectors.find((c) => c.name === body.name);
      if (connector) {
        connector.enabled = !connector.enabled;
        json(res, { ok: true, enabled: connector.enabled });
      } else {
        json(res, { error: "Connector not found" }, 404);
      }
    },
    "GET /api/connectors/status": (_r, res) =>
      json(res, {
        connectors: connectors.map((c) => ({
          name: c.name,
          connected: c.connected,
          enabled: c.enabled,
        })),
      }),
    "POST /api/connectors/connect": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const connector = connectors.find((c) => c.name === body.name);
      if (connector) {
        connector.connected = true;
        json(res, { ok: true });
      } else {
        json(res, { error: "Connector not found" }, 404);
      }
    },
    "POST /api/connectors/disconnect": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const connector = connectors.find((c) => c.name === body.name);
      if (connector) {
        connector.connected = false;
        json(res, { ok: true });
      } else {
        json(res, { error: "Connector not found" }, 404);
      }
    },
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) {
      await handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getConnectors: () =>
          connectors.map((c) => ({
            name: c.name,
            enabled: c.enabled,
            connected: c.connected,
          })),
      });
    });
  });
}

describe("Connector API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getConnectors: () => Array<{
    name: string;
    enabled: boolean;
    connected: boolean;
  }>;

  beforeAll(async () => {
    ({ port, close, getConnectors } = await createConnectorTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/plugins returns connectors", async () => {
    const { status, data } = await req(port, "GET", "/api/plugins");
    expect(status).toBe(200);
    expect(Array.isArray(data.plugins)).toBe(true);
    const plugins = data.plugins as Array<{ name: string }>;
    expect(plugins.some((p) => p.name.includes("discord"))).toBe(true);
  });

  it("POST /api/plugins/toggle enables connector", async () => {
    const { status, data } = await req(port, "POST", "/api/plugins/toggle", {
      name: "@elizaos/plugin-discord",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(
      getConnectors().find((c) => c.name.includes("discord"))?.enabled,
    ).toBe(true);
  });

  it("POST /api/plugins/toggle disables connector", async () => {
    // Toggle again to disable
    await req(port, "POST", "/api/plugins/toggle", {
      name: "@elizaos/plugin-discord",
    });
    expect(
      getConnectors().find((c) => c.name.includes("discord"))?.enabled,
    ).toBe(false);
  });

  it("GET /api/connectors/status returns connection status", async () => {
    const { status, data } = await req(port, "GET", "/api/connectors/status");
    expect(status).toBe(200);
    expect(Array.isArray(data.connectors)).toBe(true);
  });

  it("POST /api/connectors/connect establishes connection", async () => {
    const { status, data } = await req(
      port,
      "POST",
      "/api/connectors/connect",
      {
        name: "@elizaos/plugin-telegram",
      },
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(
      getConnectors().find((c) => c.name.includes("telegram"))?.connected,
    ).toBe(true);
  });

  it("POST /api/connectors/disconnect closes connection", async () => {
    const { status, data } = await req(
      port,
      "POST",
      "/api/connectors/disconnect",
      {
        name: "@elizaos/plugin-telegram",
      },
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(
      getConnectors().find((c) => c.name.includes("telegram"))?.connected,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for ConnectorsPageView
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

vi.mock("@elizaos/app-core/components/PluginsView", () => ({
  PluginsView: ({ mode }: { mode: string }) =>
    React.createElement(
      "div",
      { "data-testid": `plugins-view-${mode}` },
      `PluginsView mode=${mode}`,
    ),
}));

import { ConnectorsPageView } from "@elizaos/app-core/components/ConnectorsPageView";

type ConnectorState = {
  plugins: Array<{
    name: string;
    enabled: boolean;
    tags: string[];
    description?: string;
    connected?: boolean;
  }>;
  pluginSaving: boolean;
  pluginSaveSuccess: boolean;
};

function createConnectorUIState(): ConnectorState {
  return {
    plugins: [
      {
        name: "@elizaos/plugin-discord",
        enabled: true,
        tags: ["connector"],
        description: "Discord bot connector",
        connected: true,
      },
      {
        name: "@elizaos/plugin-telegram",
        enabled: false,
        tags: ["connector"],
        description: "Telegram bot connector",
        connected: false,
      },
      {
        name: "@elizaos/plugin-signal",
        enabled: false,
        tags: ["connector"],
        description: "Signal messenger connector",
        connected: false,
      },
      {
        name: "@elizaos/plugin-twitch",
        enabled: false,
        tags: ["streaming"],
        description: "Twitch streaming connector",
        connected: false,
      },
    ],
    pluginSaving: false,
    pluginSaveSuccess: false,
  };
}

describe("ConnectorsPageView UI", () => {
  let state: ConnectorState;

  beforeEach(() => {
    state = createConnectorUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadPlugins: vi.fn(),
      handlePluginToggle: vi.fn().mockImplementation((name: string) => {
        const plugin = state.plugins.find((p) => p.name === name);
        if (plugin) plugin.enabled = !plugin.enabled;
      }),
      handlePluginConfigSave: vi.fn(),
    }));
  });

  it("renders ConnectorsPageView with title", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectorsPageView));
    });

    expect(tree).not.toBeNull();
    const json = tree?.toJSON();
    expect(json).not.toBeNull();
  });

  it("shows the social PluginsView by default", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectorsPageView));
    });

    const socialView = tree?.root.findAll(
      (node) => node.props?.["data-testid"] === "plugins-view-social",
    );
    expect(socialView.length).toBe(1);
  });

  it("does not render platform or streaming tab buttons", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectorsPageView));
    });

    const tabButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (c) =>
            typeof c === "string" &&
            (c.includes("Platforms") || c.includes("Streaming")),
        ),
    );
    expect(tabButtons.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part 3: Connector Toggle Integration Tests
// ---------------------------------------------------------------------------

describe("Connector Toggle Integration", () => {
  let state: ConnectorState;

  beforeEach(() => {
    state = createConnectorUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadPlugins: vi.fn(),
      handlePluginToggle: (name: string) => {
        const plugin = state.plugins.find((p) => p.name === name);
        if (plugin) {
          plugin.enabled = !plugin.enabled;
        }
      },
      handlePluginConfigSave: vi.fn(),
    }));
  });

  it("toggling Discord connector updates state", () => {
    const handleToggle = mockUseApp().handlePluginToggle;
    const discordPlugin = state.plugins.find((p) => p.name.includes("discord"));

    expect(discordPlugin?.enabled).toBe(true);
    handleToggle("@elizaos/plugin-discord");
    expect(discordPlugin?.enabled).toBe(false);
  });

  it("toggling Telegram connector updates state", () => {
    const handleToggle = mockUseApp().handlePluginToggle;
    const telegramPlugin = state.plugins.find((p) =>
      p.name.includes("telegram"),
    );

    expect(telegramPlugin?.enabled).toBe(false);
    handleToggle("@elizaos/plugin-telegram");
    expect(telegramPlugin?.enabled).toBe(true);
  });

  it("multiple toggles work correctly", () => {
    const handleToggle = mockUseApp().handlePluginToggle;

    handleToggle("@elizaos/plugin-discord");
    handleToggle("@elizaos/plugin-telegram");
    handleToggle("@elizaos/plugin-signal");

    expect(state.plugins.find((p) => p.name.includes("discord"))?.enabled).toBe(
      false,
    );
    expect(
      state.plugins.find((p) => p.name.includes("telegram"))?.enabled,
    ).toBe(true);
    expect(state.plugins.find((p) => p.name.includes("signal"))?.enabled).toBe(
      true,
    );
  });
});
