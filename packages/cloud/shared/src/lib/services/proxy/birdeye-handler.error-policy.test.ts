/**
 * Proves designed Birdeye route failures remain explicit and that the shared
 * paid engine's failure response is returned without fabricating success.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";

const executeWithBody = mock();
mock.module("./engine", () => ({ executeWithBody }));

const { handleBirdeyeMarketDataProxyGet } = await import("./birdeye-handler");

const admission = {
  mode: "compatibility" as const,
  auth: {
    user: {
      id: "user-1",
      organization_id: "00000000-0000-4000-8000-0000000000aa",
    },
  },
  requestId: "birdeye-errors",
};

function makeContext(path: string, env: Record<string, unknown>): Context<AppEnv> {
  const url = `https://api.elizacloud.ai/proxy/${path}`;
  const raw = new Request(url);
  return {
    env,
    req: {
      raw,
      param: (key: string) => (key === "*" ? path : undefined),
      url,
      header: () => undefined,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

beforeEach(() => executeWithBody.mockReset());

test("unpriced path is a designed 400 before provider admission", async () => {
  const response = await handleBirdeyeMarketDataProxyGet(
    makeContext("defi/not_a_real_path", { BIRDEYE_API_KEY: "key" }),
    admission,
  );

  expect(response.status).toBe(400);
  expect(executeWithBody).not.toHaveBeenCalled();
});

test("missing provider configuration is a designed 503 before dispatch", async () => {
  const response = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price", {}), admission);

  expect(response.status).toBe(503);
  expect(executeWithBody).not.toHaveBeenCalled();
});

test("shared engine failure stays a visible non-success response", async () => {
  executeWithBody.mockResolvedValueOnce(
    Response.json({ error: "Upstream service error" }, { status: 502 }),
  );
  const response = await handleBirdeyeMarketDataProxyGet(
    makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
    admission,
  );

  expect(response.status).toBe(502);
  expect(response.ok).toBe(false);
  expect(executeWithBody).toHaveBeenCalledTimes(1);
});
