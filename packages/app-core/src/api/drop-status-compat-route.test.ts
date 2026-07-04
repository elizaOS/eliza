/**
 * Unit test for handleDropStatusCompatRoute: GET /api/drop/status is claimed
 * (returns true) only when the sensitive-route auth gate rejects; authorized or
 * non-matching requests fall through (returns false). The auth gate is mocked
 * under both `./auth` and `./auth.ts` specifiers, with per-test module resets.
 */
import http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureCompatSensitiveRouteAuthorized: vi.fn(),
}));

// Mock under both module specifiers so the mock is matched on Windows too
// (Vitest/Vite resolves the `.ts`-suffixed import id differently on win32).
vi.mock("./auth", () => ({
  ensureCompatSensitiveRouteAuthorized:
    mocks.ensureCompatSensitiveRouteAuthorized,
}));

vi.mock("./auth.ts", () => ({
  ensureCompatSensitiveRouteAuthorized:
    mocks.ensureCompatSensitiveRouteAuthorized,
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

function fakeReq(pathname = "/api/drop/status"): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = pathname;
  req.headers = { host: "localhost:2138" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function fakeRes(): http.ServerResponse {
  return new http.ServerResponse(fakeReq());
}

// This suite runs under `isolate: false` (vitest.config.ts), so app-core test
// files share one module registry and several mock `./auth`. If the route
// module was first imported under another file's `./auth` mock (e.g.
// dev-route-catalog's hardcoded `() => true`), its `ensureCompatSensitiveRoute…`
// binding is frozen to that mock. Reset the registry and re-import the route per
// test so it binds to THIS file's controllable mock (#9464).
async function loadRoute() {
  vi.resetModules();
  const mod = await import("./drop-status-compat-route");
  return mod.handleDropStatusCompatRoute;
}

describe("handleDropStatusCompatRoute", () => {
  beforeEach(() => {
    mocks.ensureCompatSensitiveRouteAuthorized.mockReset();
  });

  it("ignores non-drop-status routes", async () => {
    const handleDropStatusCompatRoute = await loadRoute();
    const handled = handleDropStatusCompatRoute(
      fakeReq("/api/agent/status"),
      fakeRes(),
      "GET",
      "/api/agent/status",
    );

    expect(handled).toBe(false);
    expect(mocks.ensureCompatSensitiveRouteAuthorized).not.toHaveBeenCalled();
  });

  it("handles unauthorized drop status requests locally", async () => {
    mocks.ensureCompatSensitiveRouteAuthorized.mockReturnValue(false);
    const handleDropStatusCompatRoute = await loadRoute();
    const req = fakeReq();
    const res = fakeRes();

    const handled = handleDropStatusCompatRoute(
      req,
      res,
      "GET",
      "/api/drop/status",
    );

    expect(handled).toBe(true);
    expect(mocks.ensureCompatSensitiveRouteAuthorized).toHaveBeenCalledWith(
      req,
      res,
    );
  });

  it("falls through for authorized drop status requests", async () => {
    mocks.ensureCompatSensitiveRouteAuthorized.mockReturnValue(true);
    const handleDropStatusCompatRoute = await loadRoute();
    const req = fakeReq();
    const res = fakeRes();

    const handled = handleDropStatusCompatRoute(
      req,
      res,
      "GET",
      "/api/drop/status",
    );

    expect(handled).toBe(false);
    expect(mocks.ensureCompatSensitiveRouteAuthorized).toHaveBeenCalledWith(
      req,
      res,
    );
  });
});
