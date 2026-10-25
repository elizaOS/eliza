/**
 * Goals routes on a real PGlite runtime: typed GoalsService failures (bad
 * input, unknown goal) must answer with their own HTTP status instead of being
 * rethrown to the host server as a 500.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { UUID } from "@elizaos/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "../src/routes/lifeops-routes.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

let result: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | null = null;

beforeAll(async () => {
  result = await createLifeOpsTestRuntime({
    characterName: "goals-route-status",
  });
}, 180_000);

afterAll(async () => {
  await result?.cleanup();
  result = null;
});

async function call(
  method: string,
  pathname: string,
  payload: unknown = null,
): Promise<{ status: number; body: string }> {
  if (!result) throw new Error("runtime not started");
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const req = new IncomingMessage(socket);
  req.method = method;
  const res = new ServerResponse(req);
  let body = "";
  res.end = function end(this: ServerResponse, chunk?: unknown) {
    body = typeof chunk === "string" ? chunk : "";
    return this;
  };
  const ctx: LifeOpsRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    state: {
      runtime: result.runtime,
      adminEntityId: crypto.randomUUID() as UUID,
    },
    json(r, data, status = 200) {
      r.statusCode = status;
      r.end(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      r.statusCode = status;
      r.end(JSON.stringify({ error: message }));
    },
    async readJsonBody() {
      return payload as never;
    },
    decodePathComponent: (raw) => decodeURIComponent(raw),
  };
  await handleLifeOpsRoutes(ctx);
  return { status: res.statusCode, body };
}

it("answers 400 when a created goal's cadence has no kind", async () => {
  const response = await call("POST", "/api/lifeops/goals", {
    title: "Walk the dog nightly",
    cadence: { everyMinutes: 60 },
  });
  expect(response.status).toBe(400);
  expect(response.body).toContain("'kind'");
}, 60_000);

it.each([
  ["GET", null],
  ["PUT", { title: "Renamed" }],
  ["DELETE", null],
] as const)(
  "answers 404 for %s on an unknown goal",
  async (method, payload) => {
    const response = await call(
      method,
      `/api/lifeops/goals/${crypto.randomUUID()}`,
      payload,
    );
    expect(response.status).toBe(404);
  },
  60_000,
);
