/**
 * Unit + route tests for buildRouteCatalog and GET /api/dev/route-catalog: the
 * catalog covers every TAB_PATHS entry and mirrors SETTINGS_SECTION_META from
 * @elizaos/ui exactly, and the route is loopback-only and disabled in
 * production. Auth, config, and port resolution are mocked to true/fixed values.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { SETTINGS_SECTION_META } from "@elizaos/ui/components/settings/settings-section-meta";
import { TAB_PATHS } from "@elizaos/ui/navigation";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { buildRouteCatalog } from "./dev-route-catalog";

// ── mocks ──────────────────────────────────────────────────────────────

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
});

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("@elizaos/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/shared")>();
  return {
    ...actual,
    resolveDesktopApiPort: () => 31337,
    resolveDesktopUiPort: () => null,
  };
});

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return {
    ...actual,
    ensureRouteAuthorized: vi.fn(async () => true),
    ensureCompatSensitiveRouteAuthorized: () => true,
    getCompatApiToken: () => null,
    getProvidedApiToken: () => null,
    tokenMatches: () => true,
  };
});

vi.mock("./auth/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth/sessions")>();
  return {
    ...actual,
    findActiveSession: vi.fn(async () => null),
    parseSessionCookie: vi.fn(() => null),
  };
});

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const AUTH_ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "NODE_ENV",
] as const;

// ── test helpers ───────────────────────────────────────────────────────

let handleDevCompatRoutes: typeof import("./dev-compat-routes").handleDevCompatRoutes;

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(opts: {
  method: string;
  pathname: string;
  remoteAddress?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method;
  req.url = opts.pathname;
  req.headers = { host: "localhost:2138" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  return req;
}

// ── tests ──────────────────────────────────────────────────────────────

describe("buildRouteCatalog", () => {
  it("returns at least 30 route entries", () => {
    const catalog = buildRouteCatalog();
    expect(catalog.routes.length).toBeGreaterThanOrEqual(30);
  });

  it("represents every TAB_PATHS key from packages/ui/src/navigation", () => {
    const catalog = buildRouteCatalog();
    const tabIds = new Set(catalog.routes.map((r) => r.tabId));
    const missing: string[] = [];
    for (const tabId of Object.keys(TAB_PATHS)) {
      if (!tabIds.has(tabId)) missing.push(tabId);
    }
    expect(missing).toEqual([]);
  });

  it("uses the path declared by TAB_PATHS for each represented tab", () => {
    const catalog = buildRouteCatalog();
    // Multiple route entries can map to the same tabId (e.g. 'triggers' /
    // 'automations' both resolve to /automations). Verify each entry matches
    // its TAB_PATHS source rather than asserting one entry per tabId.
    for (const route of catalog.routes) {
      const expected = (TAB_PATHS as Record<string, string>)[route.tabId];
      if (expected !== undefined) {
        expect(route.path).toBe(expected);
      }
    }
  });

  it("declares a schemaVersion and an ISO generatedAt timestamp", () => {
    const catalog = buildRouteCatalog(new Date("2026-05-10T00:00:00.000Z"));
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.generatedAt).toBe("2026-05-10T00:00:00.000Z");
  });

  it("mirrors SETTINGS_SECTION_META from @elizaos/ui exactly (id + label, in order)", () => {
    const catalog = buildRouteCatalog();
    expect(
      catalog.settingsSections.map((s) => ({ id: s.id, label: s.label })),
    ).toEqual(
      SETTINGS_SECTION_META.map((s) => ({
        id: s.id,
        label: s.defaultLabel,
      })),
    );
  });

  it("returns settings sections and modal triggers", () => {
    const catalog = buildRouteCatalog();
    expect(catalog.settingsSections.length).toBeGreaterThanOrEqual(5);
    expect(catalog.modals.length).toBeGreaterThanOrEqual(3);
    for (const section of catalog.settingsSections) {
      expect(section.id.length).toBeGreaterThan(0);
      expect(section.label.length).toBeGreaterThan(0);
    }
    for (const modal of catalog.modals) {
      expect(modal.id.length).toBeGreaterThan(0);
      expect(modal.trigger.length).toBeGreaterThan(0);
    }

    const retiredModalId = ["signal", "qr"].join("-");
    expect(catalog.modals.map((modal) => modal.id)).not.toContain(
      retiredModalId,
    );
  });
});

describe("GET /api/dev/route-catalog", () => {
  const savedAuthEnv: Record<
    (typeof AUTH_ENV_KEYS)[number],
    string | undefined
  > = {
    ELIZA_API_TOKEN: undefined,
    ELIZA_CLOUD_PROVISIONED: undefined,
    ELIZA_DEV_AUTH_BYPASS: undefined,
    ELIZA_REQUIRE_LOCAL_AUTH: undefined,
    NODE_ENV: undefined,
  };

  beforeAll(async () => {
    handleDevCompatRoutes = (await import("./dev-compat-routes"))
      .handleDevCompatRoutes;
  });

  beforeEach(() => {
    for (const key of AUTH_ENV_KEYS) {
      savedAuthEnv[key] = process.env[key];
      delete process.env[key];
    }
    Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
    for (const key of AUTH_ENV_KEYS) {
      if (savedAuthEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedAuthEnv[key];
    }
  });

  it("returns 200 with JSON payload on loopback", async () => {
    const res = fakeRes();
    const handled = await handleDevCompatRoutes(
      fakeReq({ method: "GET", pathname: "/api/dev/route-catalog" }),
      res.res,
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    const body = res.body() as {
      schemaVersion: number;
      routes: unknown[];
      settingsSections: unknown[];
      modals: unknown[];
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.routes.length).toBeGreaterThanOrEqual(30);
    expect(body.settingsSections.length).toBeGreaterThan(0);
    expect(body.modals.length).toBeGreaterThan(0);
  });

  it("rejects non-loopback callers with 403", async () => {
    const res = fakeRes();
    const handled = await handleDevCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/dev/route-catalog",
        remoteAddress: "10.0.0.42",
      }),
      res.res,
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(403);
    expect(res.body()).toEqual({ error: "loopback only" });
  });

  it("returns 404 in production NODE_ENV", async () => {
    process.env.NODE_ENV = "production";
    const res = fakeRes();
    const handled = await handleDevCompatRoutes(
      fakeReq({ method: "GET", pathname: "/api/dev/route-catalog" }),
      res.res,
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(404);
  });
});
