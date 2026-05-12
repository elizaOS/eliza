import * as http from "node:http";
import { Socket } from "node:net";
import { TAB_PATHS } from "@elizaos/ui/navigation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { buildRouteCatalog } from "./dev-route-catalog";

// ── mocks ──────────────────────────────────────────────────────────────

vi.mock("@elizaos/core", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("@elizaos/shared", () => ({
  isLoopbackBindHost: () => true,
  normalizeOnboardingProviderId: () => null,
  resolveDeploymentTargetInConfig: () => ({}),
  resolveServiceRoutingInConfig: () => ({}),
  resolveDesktopApiPort: () => 31337,
  resolveDesktopUiPort: () => null,
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  ensureCompatSensitiveRouteAuthorized: () => true,
  getCompatApiToken: () => null,
  getProvidedApiToken: () => null,
  tokenMatches: () => true,
}));

vi.mock("./auth/sessions", () => ({
  findActiveSession: vi.fn(async () => null),
  parseSessionCookie: vi.fn(() => null),
}));

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

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
  });
});

describe("GET /api/dev/route-catalog", () => {
  beforeAll(async () => {
    handleDevCompatRoutes = (await import("./dev-compat-routes"))
      .handleDevCompatRoutes;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
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
