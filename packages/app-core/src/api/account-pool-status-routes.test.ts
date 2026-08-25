/**
 * Tests for the public account-pool status route (GET /api/pool/status):
 * environment gating, method authorization, cache-control headers,
 * upstream service error translation with retry-after, and path matching.
 */
import { EventEmitter } from "node:events";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAccountPoolStatusRoute } from "./account-pool-status-routes";

const getPublicAccountPoolStatus = vi.fn();
const dependencies = { getPublicAccountPoolStatus };

function response(): http.ServerResponse & {
  body: string;
  statusCode: number;
} {
  const res = new EventEmitter() as unknown as http.ServerResponse & {
    body: string;
    statusCode: number;
  };
  res.body = "";
  res.statusCode = 200;
  res.setHeader = vi.fn() as unknown as typeof res.setHeader;
  res.end = vi.fn((chunk?: string) => {
    res.body += chunk ?? "";
    return res;
  }) as unknown as typeof res.end;
  return res;
}

const previousPublicStatus =
  process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED;

beforeEach(() => {
  getPublicAccountPoolStatus.mockReset();
  process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED = "1";
});

afterEach(() => {
  if (previousPublicStatus === undefined) {
    delete process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED;
  } else {
    process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED = previousPublicStatus;
  }
});

describe("GET /api/pool/status", () => {
  it("returns 404 unless public status is explicitly enabled", async () => {
    delete process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED;
    const res = response();
    await expect(
      handleAccountPoolStatusRoute(
        {} as http.IncomingMessage,
        res,
        "GET",
        "/api/pool/status",
        dependencies,
      ),
    ).resolves.toBe(true);
    expect(res.statusCode).toBe(404);
    expect(getPublicAccountPoolStatus).not.toHaveBeenCalled();
  });

  it("serves the public-safe service result", async () => {
    getPublicAccountPoolStatus.mockResolvedValue({ pool: { accounts: 2 } });
    const res = response();
    await expect(
      handleAccountPoolStatusRoute(
        {} as http.IncomingMessage,
        res,
        "GET",
        "/api/pool/status",
        dependencies,
      ),
    ).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ pool: { accounts: 2 } });
  });

  it("rejects non-GET methods and returns 503 with retry-after on refresh failure", async () => {
    const methodRes = response();
    await handleAccountPoolStatusRoute(
      {} as http.IncomingMessage,
      methodRes,
      "POST",
      "/api/pool/status",
      dependencies,
    );
    expect(methodRes.statusCode).toBe(405);

    getPublicAccountPoolStatus.mockRejectedValue(new Error("unavailable"));
    const errorRes = response();
    await handleAccountPoolStatusRoute(
      {} as http.IncomingMessage,
      errorRes,
      "GET",
      "/api/pool/status",
      dependencies,
    );
    expect(errorRes.statusCode).toBe(503);
    expect(errorRes.setHeader).toHaveBeenCalledWith("retry-after", "60");
  });

  it("ignores non-matching paths and returns false", async () => {
    const res = response();
    const handled = await handleAccountPoolStatusRoute(
      {} as http.IncomingMessage,
      res,
      "GET",
      "/api/pool/other",
      dependencies,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(getPublicAccountPoolStatus).not.toHaveBeenCalled();
  });

  it.each(["true", "TRUE", "yes", "YES", "on", "ON", " 1 "])(
    "enables the route for truthy flag value %j",
    async (flagValue) => {
      process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED = flagValue;
      getPublicAccountPoolStatus.mockResolvedValue({ pool: { accounts: 1 } });
      const res = response();
      const handled = await handleAccountPoolStatusRoute(
        {} as http.IncomingMessage,
        res,
        "GET",
        "/api/pool/status",
        dependencies,
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(getPublicAccountPoolStatus).toHaveBeenCalled();
    },
  );

  it.each(["0", "false", "no", "off", "disabled", "random", ""])(
    "disables the route for non-truthy flag value %j",
    async (flagValue) => {
      process.env.ELIZA_ACCOUNT_POOL_PUBLIC_STATUS_ENABLED = flagValue;
      const res = response();
      const handled = await handleAccountPoolStatusRoute(
        {} as http.IncomingMessage,
        res,
        "GET",
        "/api/pool/status",
        dependencies,
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
      expect(res.setHeader).toHaveBeenCalledWith("cache-control", "no-store");
      expect(getPublicAccountPoolStatus).not.toHaveBeenCalled();
    },
  );

  it("sets public max-age cache control on success", async () => {
    getPublicAccountPoolStatus.mockResolvedValue({ pool: { accounts: 3 } });
    const res = response();
    await handleAccountPoolStatusRoute(
      {} as http.IncomingMessage,
      res,
      "GET",
      "/api/pool/status",
      dependencies,
    );
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "public, max-age=60",
    );
  });

  it.each(["PUT", "DELETE", "PATCH"])(
    "rejects %s method with HTTP 405",
    async (method) => {
      const res = response();
      await handleAccountPoolStatusRoute(
        {} as http.IncomingMessage,
        res,
        method,
        "/api/pool/status",
        dependencies,
      );
      expect(res.statusCode).toBe(405);
      expect(res.setHeader).toHaveBeenCalledWith("allow", "GET");
      expect(JSON.parse(res.body)).toEqual({ error: "method not allowed" });
    },
  );
});
