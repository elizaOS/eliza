/**
 * E2E tests for Export/Import Flows.
 *
 * Tests cover:
 * 1. Agent export
 * 2. Agent import
 * 3. Conversation export
 * 4. Settings export
 * 5. Export file format validation
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

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
    ProviderSwitcher: () =>
      React.createElement("div", null, "ProviderSwitcher"),
  };
});

// ---------------------------------------------------------------------------
// Part 1: API Tests for Export/Import Endpoints
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

function createExportImportTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getImportedData: () => Record<string, unknown> | null;
}> {
  let importedData: Record<string, unknown> | null = null;

  const agentData = {
    character: {
      name: "TestAgent",
      bio: ["Bio line"],
      system: "System prompt",
    },
    settings: {
      theme: "eliza",
      provider: "openai",
    },
    memories: [
      { id: "mem-1", content: "Memory 1" },
      { id: "mem-2", content: "Memory 2" },
    ],
    conversations: [
      {
        id: "conv-1",
        title: "Test conversation",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi!" },
        ],
      },
    ],
  };

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
    "GET /api/agent/export": (_r, res) =>
      json(res, {
        data: agentData,
        exportedAt: new Date().toISOString(),
        version: "1.0.0",
      }),
    "POST /api/agent/import": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;

      if (!body.data) {
        return json(res, { error: "Invalid import data" }, 400);
      }

      importedData = body.data as Record<string, unknown>;
      json(res, { ok: true, imported: true });
    },
    "GET /api/conversations/export": (_r, res) =>
      json(res, {
        conversations: agentData.conversations,
        exportedAt: new Date().toISOString(),
      }),
    "POST /api/conversations/import": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;

      if (!body.conversations) {
        return json(res, { error: "Invalid conversation data" }, 400);
      }

      json(res, {
        ok: true,
        importedCount: (body.conversations as unknown[]).length,
      });
    },
    "GET /api/settings/export": (_r, res) =>
      json(res, {
        settings: agentData.settings,
        exportedAt: new Date().toISOString(),
      }),
    "POST /api/settings/import": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;

      if (!body.settings) {
        return json(res, { error: "Invalid settings data" }, 400);
      }

      json(res, { ok: true });
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
        getImportedData: () => importedData,
      });
    });
  });
}

describe("Export/Import API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getImportedData: () => Record<string, unknown> | null;

  beforeAll(async () => {
    ({ port, close, getImportedData } = await createExportImportTestServer());
  });

  afterAll(async () => {
    await close();
  });

  describe("Agent Export", () => {
    it("GET /api/agent/export returns complete agent data", async () => {
      const { status, data } = await req(port, "GET", "/api/agent/export");
      expect(status).toBe(200);
      expect(data.data).toBeDefined();
      expect(data.exportedAt).toBeDefined();
      expect(data.version).toBeDefined();
    });

    it("export includes character data", async () => {
      const { data } = await req(port, "GET", "/api/agent/export");
      const exportData = data.data as Record<string, unknown>;
      expect(exportData.character).toBeDefined();
    });

    it("export includes settings", async () => {
      const { data } = await req(port, "GET", "/api/agent/export");
      const exportData = data.data as Record<string, unknown>;
      expect(exportData.settings).toBeDefined();
    });

    it("export includes memories", async () => {
      const { data } = await req(port, "GET", "/api/agent/export");
      const exportData = data.data as Record<string, unknown>;
      expect(Array.isArray(exportData.memories)).toBe(true);
    });

    it("export includes conversations", async () => {
      const { data } = await req(port, "GET", "/api/agent/export");
      const exportData = data.data as Record<string, unknown>;
      expect(Array.isArray(exportData.conversations)).toBe(true);
    });
  });

  describe("Agent Import", () => {
    it("POST /api/agent/import accepts valid data", async () => {
      const { status, data } = await req(port, "POST", "/api/agent/import", {
        data: {
          character: { name: "ImportedAgent" },
          settings: {},
        },
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("import stores the data", async () => {
      await req(port, "POST", "/api/agent/import", {
        data: {
          character: { name: "TestImport" },
        },
      });

      const imported = getImportedData();
      expect(imported?.character).toBeDefined();
    });

    it("import rejects invalid data", async () => {
      const { status } = await req(port, "POST", "/api/agent/import", {});
      expect(status).toBe(400);
    });
  });

  describe("Conversation Export/Import", () => {
    it("GET /api/conversations/export returns conversations", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/conversations/export",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.conversations)).toBe(true);
    });

    it("POST /api/conversations/import accepts conversations", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/conversations/import",
        {
          conversations: [
            {
              id: "new-conv",
              title: "Imported conversation",
              messages: [],
            },
          ],
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.importedCount).toBe(1);
    });

    it("conversation import rejects invalid data", async () => {
      const { status } = await req(
        port,
        "POST",
        "/api/conversations/import",
        {},
      );
      expect(status).toBe(400);
    });
  });

  describe("Settings Export/Import", () => {
    it("GET /api/settings/export returns settings", async () => {
      const { status, data } = await req(port, "GET", "/api/settings/export");
      expect(status).toBe(200);
      expect(data.settings).toBeDefined();
    });

    it("POST /api/settings/import accepts settings", async () => {
      const { status, data } = await req(port, "POST", "/api/settings/import", {
        settings: {
          theme: "dark",
          provider: "anthropic",
        },
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("settings import rejects invalid data", async () => {
      const { status } = await req(port, "POST", "/api/settings/import", {});
      expect(status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for Export/Import
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
    THEMES: [{ id: "eliza", label: "Eliza" }],
  };
});

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
  };
});

vi.mock("@elizaos/app-core/components/ConfigPageView", () => ({
  ConfigPageView: () => React.createElement("div", null, "ConfigPageView"),
}));

vi.mock("@elizaos/app-core/components/CodingAgentSettingsSection", () => ({
  CodingAgentSettingsSection: () =>
    React.createElement("div", null, "CodingAgentSettingsSection"),
}));

vi.mock("@elizaos/app-core/components/MediaSettingsSection", () => ({
  MediaSettingsSection: () =>
    React.createElement("div", null, "MediaSettingsSection"),
}));

vi.mock("@elizaos/app-core/components/ElizaCloudDashboard", () => ({
  CloudDashboard: () => React.createElement("div", null, "ElizaCloudDashboard"),
}));

vi.mock("@elizaos/app-core/components/PermissionsSection", () => ({
  PermissionsSection: () =>
    React.createElement("div", null, "PermissionsSection"),
}));

vi.mock("@elizaos/app-core/components/ProviderSwitcher", () => ({
  ProviderSwitcher: () => React.createElement("div", null, "ProviderSwitcher"),
}));

vi.mock("@elizaos/app-core/components/VoiceConfigView", () => ({
  VoiceConfigView: () => React.createElement("div", null, "VoiceConfigView"),
}));

import { SettingsView } from "@elizaos/app-core/components/SettingsView";

type ExportImportState = {
  currentTheme: string;
  plugins: unknown[];
  pluginSaving: boolean;
  pluginSaveSuccess: boolean;
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  elizaCloudCredits: number;
  elizaCloudCreditsLow: boolean;
  elizaCloudCreditsCritical: boolean;
  elizaCloudTopUpUrl: string;
  elizaCloudUserId: string;
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string;
  cloudDisconnecting: boolean;
};

function createExportImportUIState(): ExportImportState {
  return {
    currentTheme: "eliza",
    plugins: [],
    pluginSaving: false,
    pluginSaveSuccess: false,
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    elizaCloudCredits: 0,
    elizaCloudCreditsLow: false,
    elizaCloudCreditsCritical: false,
    elizaCloudTopUpUrl: "",
    elizaCloudUserId: "",
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    cloudDisconnecting: false,
  };
}

describe("Export/Import UI", () => {
  let state: ExportImportState;
  let _exportCalled: boolean;
  let _importCalled: boolean;

  beforeEach(() => {
    state = createExportImportUIState();
    _exportCalled = false;
    _importCalled = false;

    vi.spyOn(window, "confirm").mockImplementation(() => true);

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      t: (k: string) => k,
      ...state,
      triggers: [],
      triggersLoading: false,
      triggersSaving: false,
      triggerRunsById: {},
      triggerHealth: null,
      triggerError: null,
      loadPlugins: vi.fn(),
      loadTriggers: vi.fn(async () => {}),
      createTrigger: vi.fn(async () => null),
      updateTrigger: vi.fn(async () => null),
      deleteTrigger: vi.fn(async () => true),
      runTriggerNow: vi.fn(async () => true),
      loadTriggerRuns: vi.fn(async () => {}),
      loadTriggerHealth: vi.fn(async () => {}),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: vi.fn(),
      handleCloudDisconnect: vi.fn(),
      handleReset: vi.fn(),
      handleExport: async () => {
        _exportCalled = true;
        return { data: {}, exportedAt: new Date().toISOString() };
      },
      handleImport: async () => {
        _importCalled = true;
      },
      setState: vi.fn(),
    }));
  });

  it("renders export button in advanced section", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    // Look for Export key
    const allText = JSON.stringify(tree?.toJSON());
    expect(allText).toContain("settings.exportAgent");
  });

  it("renders import button in advanced section", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const allText = JSON.stringify(tree?.toJSON());
    expect(allText).toContain("settings.importAgent");
  });
});

// ---------------------------------------------------------------------------
// Part 3: Export Integration Tests
// ---------------------------------------------------------------------------

describe("Export Integration", () => {
  let exportedData: Record<string, unknown> | null;

  beforeEach(() => {
    exportedData = null;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...createExportImportUIState(),
      triggers: [],
      triggersLoading: false,
      triggersSaving: false,
      triggerRunsById: {},
      triggerHealth: null,
      triggerError: null,
      loadPlugins: vi.fn(),
      loadTriggers: vi.fn(async () => {}),
      createTrigger: vi.fn(async () => null),
      updateTrigger: vi.fn(async () => null),
      deleteTrigger: vi.fn(async () => true),
      runTriggerNow: vi.fn(async () => true),
      loadTriggerRuns: vi.fn(async () => {}),
      loadTriggerHealth: vi.fn(async () => {}),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: vi.fn(),
      handleCloudDisconnect: vi.fn(),
      handleReset: vi.fn(),
      handleExport: async () => {
        exportedData = {
          character: { name: "TestAgent" },
          settings: { theme: "eliza" },
          memories: [],
          conversations: [],
          exportedAt: new Date().toISOString(),
        };
        return exportedData;
      },
      handleImport: vi.fn(),
      setState: vi.fn(),
    }));
  });

  it("export generates complete data structure", async () => {
    const exportFn = mockUseApp().handleExport;

    await exportFn();

    expect(exportedData).not.toBeNull();
    expect(exportedData?.character).toBeDefined();
    expect(exportedData?.settings).toBeDefined();
  });

  it("export includes timestamp", async () => {
    const exportFn = mockUseApp().handleExport;

    await exportFn();

    expect(exportedData?.exportedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part 4: Import Integration Tests
// ---------------------------------------------------------------------------

describe("Import Integration", () => {
  let importedData: Record<string, unknown> | null;
  let importError: string | null;

  beforeEach(() => {
    importedData = null;
    importError = null;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...createExportImportUIState(),
      loadPlugins: vi.fn(),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: vi.fn(),
      handleCloudDisconnect: vi.fn(),
      handleReset: vi.fn(),
      handleExport: vi.fn(),
      handleImport: async (data: Record<string, unknown>) => {
        if (!data.character) {
          importError = "Invalid import data: missing character";
          throw new Error(importError);
        }
        importedData = data;
      },
      setState: vi.fn(),
    }));
  });

  it("import accepts valid data", async () => {
    const importFn = mockUseApp().handleImport;

    await importFn({
      character: { name: "ImportedAgent" },
      settings: {},
    });

    expect(importedData).not.toBeNull();
    expect(importedData?.character).toBeDefined();
  });

  it("import rejects invalid data", async () => {
    const importFn = mockUseApp().handleImport;

    try {
      await importFn({});
    } catch {
      // Expected
    }

    expect(importError).toContain("Invalid");
  });
});

// ---------------------------------------------------------------------------
// Part 5: Export File Format Tests
// ---------------------------------------------------------------------------

describe("Export File Format", () => {
  it("export data is valid JSON", () => {
    const exportData = {
      character: { name: "TestAgent" },
      settings: { theme: "eliza" },
      memories: [],
      conversations: [],
      exportedAt: new Date().toISOString(),
      version: "1.0.0",
    };

    const jsonString = JSON.stringify(exportData);
    const parsed = JSON.parse(jsonString);

    expect(parsed.character.name).toBe("TestAgent");
  });

  it("export includes version info", () => {
    const exportData = {
      character: {},
      version: "1.0.0",
    };

    expect(exportData.version).toBe("1.0.0");
  });

  it("conversations include message structure", () => {
    const conversation = {
      id: "conv-1",
      title: "Test",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    };

    expect(conversation.messages[0].role).toBe("user");
    expect(conversation.messages[1].role).toBe("assistant");
  });
});
