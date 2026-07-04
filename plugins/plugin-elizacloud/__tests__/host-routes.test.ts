import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handleCloudBillingRoute,
  handleCloudCompatRoute,
  handleCloudRelayRoute,
  handleCloudRoute,
} from "../src/host-routes";

/**
 * Seam test for the typed host-route contract (issue #12094 item 2).
 *
 * `@elizaos/agent`'s server-route dispatcher lazily imports this module
 * (`@elizaos/plugin-elizacloud/host-routes`) and dispatches through these
 * exact exported signatures — no `unknown[]` shims, no `as never` casts. This
 * test drives the real handlers (not mocks): with no cloud credentials and no
 * runtime, each must reach its owner logic and answer, proving the contract the
 * agent imports actually dispatches. No network is touched (all short-circuit
 * before any upstream call).
 */

function makeResponse() {
  let statusCode = 200;
  let raw = "";
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    end: (chunk?: string) => {
      if (typeof chunk === "string") raw = chunk;
      (res as { headersSent: boolean }).headersSent = true;
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body(): unknown {
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

const req = { url: "/", method: "GET" } as http.IncomingMessage;

describe("plugin-elizacloud host-routes contract", () => {
  it("handleCloudBillingRoute dispatches and 401s without credentials", async () => {
    const cap = makeResponse();
    const handled = await handleCloudBillingRoute(
      req,
      cap.res,
      "/api/cloud/billing/summary",
      "GET",
      { config: {}, runtime: null }
    );
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(401);
    expect(cap.body).toMatchObject({ error: expect.any(String) });
  });

  it("handleCloudBillingRoute ignores non-billing paths", async () => {
    const cap = makeResponse();
    const handled = await handleCloudBillingRoute(req, cap.res, "/api/cloud/other", "GET", {
      config: {},
      runtime: null,
    });
    expect(handled).toBe(false);
    expect(cap.statusCode).toBe(200);
  });

  it("handleCloudCompatRoute dispatches and 401s without credentials", async () => {
    const cap = makeResponse();
    const handled = await handleCloudCompatRoute(req, cap.res, "/api/cloud/compat/models", "GET", {
      config: {},
      runtime: null,
    });
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(401);
  });

  it("handleCloudRelayRoute reports no_runtime when runtime is absent", async () => {
    const cap = makeResponse();
    const json = vi.fn();
    const handled = await handleCloudRelayRoute(
      req,
      cap.res,
      "/api/cloud/relay-status",
      "GET",
      { runtime: undefined },
      { json, error: vi.fn(), readJsonBody: vi.fn() }
    );
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(cap.res, expect.objectContaining({ available: false }));
  });

  it("handleCloudRoute serves relay-status with no runtime (available:false)", async () => {
    const cap = makeResponse();
    const handled = await handleCloudRoute(req, cap.res, "/api/cloud/relay-status", "GET", {
      config: {},
      cloudManager: null,
      runtime: null,
    });
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(200);
    expect(cap.body).toMatchObject({ available: false });
  });
});
