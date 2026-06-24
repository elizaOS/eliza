import http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDropStatusCompatRoute } from "./drop-status-compat-route";

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

describe("handleDropStatusCompatRoute", () => {
  beforeEach(() => {
    mocks.ensureCompatSensitiveRouteAuthorized.mockReset();
  });

  it("ignores non-drop-status routes", () => {
    const handled = handleDropStatusCompatRoute(
      fakeReq("/api/agent/status"),
      fakeRes(),
      "GET",
      "/api/agent/status",
    );

    expect(handled).toBe(false);
    expect(mocks.ensureCompatSensitiveRouteAuthorized).not.toHaveBeenCalled();
  });

  it("handles unauthorized drop status requests locally", () => {
    mocks.ensureCompatSensitiveRouteAuthorized.mockReturnValue(false);
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

  it("falls through for authorized drop status requests", () => {
    mocks.ensureCompatSensitiveRouteAuthorized.mockReturnValue(true);
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
