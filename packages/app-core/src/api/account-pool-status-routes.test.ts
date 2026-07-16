import { EventEmitter } from "node:events";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPublicAccountPoolStatus } = vi.hoisted(() => ({
  getPublicAccountPoolStatus: vi.fn(),
}));
vi.mock("../services/account-pool-status", () => ({
  getPublicAccountPoolStatus,
}));

import { handleAccountPoolStatusRoute } from "./account-pool-status-routes";

function response(): http.ServerResponse & {
  body: string;
  statusCode: number;
} {
  const res = new EventEmitter() as http.ServerResponse & {
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

beforeEach(() => vi.clearAllMocks());

describe("GET /api/pool/status", () => {
  it("serves the public-safe service result", async () => {
    getPublicAccountPoolStatus.mockResolvedValue({ pool: { accounts: 2 } });
    const res = response();
    await expect(
      handleAccountPoolStatusRoute(
        {} as http.IncomingMessage,
        res,
        "GET",
        "/api/pool/status",
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
    );
    expect(methodRes.statusCode).toBe(405);

    getPublicAccountPoolStatus.mockRejectedValue(new Error("unavailable"));
    const errorRes = response();
    await handleAccountPoolStatusRoute(
      {} as http.IncomingMessage,
      errorRes,
      "GET",
      "/api/pool/status",
    );
    expect(errorRes.statusCode).toBe(503);
    expect(errorRes.setHeader).toHaveBeenCalledWith("retry-after", "60");
  });
});
