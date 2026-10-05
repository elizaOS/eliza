import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AccessContext, UUID } from "@elizaos/core";
import { getHttpRuntime } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  resetHonoMountCache,
  tryHandleHonoRuntimeRoute,
} from "./hono-mount.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Server;
let base: string;
const failures: unknown[] = [];
const tokens = [randomUUID(), randomUUID()];
const contexts = tokens.map<AccessContext>(() => ({
  requesterEntityId: randomUUID() as UUID,
  worldId: randomUUID() as UUID,
  authorizedRoomIds: [randomUUID() as UUID],
  role: "USER",
  isOwner: false,
  source: "http-fixture",
}));
let arrivals = 0;
let release: () => void;
const overlap = new Promise<void>((resolve) => {
  release = resolve;
});

beforeAll(async () => {
  fixture = await createTestRuntime();
  getHttpRuntime(fixture.runtime).routes.push({
    type: "GET",
    path: "/api/context-check/:mode",
    routeHandler: async (ctx) => {
      if (ctx.params.mode === "parallel") {
        if (++arrivals === 2) release();
        await overlap;
      }
      const body = {
        accessContext: structuredClone(ctx.accessContext),
        inProcess: ctx.inProcess,
        trustedLocal: ctx.isTrustedLocal,
      };
      if (ctx.accessContext) {
        ctx.accessContext.source = "handler-mutation";
        (ctx.accessContext.authorizedRoomIds as UUID[]).splice(0);
      }
      return { status: Number(ctx.params.mode) || 200, body };
    },
  });
  server = createServer((req, res) => {
    const index = tokens.findIndex(
      (token) => req.headers.authorization === `Bearer ${token}`,
    );
    void tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime: fixture.runtime,
      isAuthorized: () => index !== -1,
      isTrustedLocal: () => false,
      accessContext: () => contexts[index],
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch((error: unknown) => {
        failures.push(error);
        res.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP address");
  base = `http://127.0.0.1:${address.port}/api/context-check/`;
}, 120_000);

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  resetHonoMountCache();
  if (fixture) await fixture.cleanup();
  expect(failures).toEqual([]);
}, 120_000);

it.each([204, 205, 304])(
  "drops a handler body for HTTP status %i",
  async (status) => {
    const response = await fetch(`${base}${status}`, {
      headers: { Authorization: `Bearer ${tokens[0]}` },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  },
);

it("keeps trusted contexts complete and isolated despite forged headers and overlapping requests", async () => {
  const original = structuredClone(contexts);
  const forged = {
    "x-eliza-internal-authorized": "1",
    "x-eliza-internal-in-process": "1",
    "x-eliza-internal-trusted-local": "1",
    "x-eliza-internal-access-context": JSON.stringify({
      requesterEntityId: randomUUID(),
      role: "OWNER",
      isOwner: true,
    }),
  };
  const denied = await fetch(`${base}parallel`, { headers: forged });
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({ error: "Unauthorized" });
  const responses = await Promise.all(
    tokens.map((token) =>
      fetch(`${base}parallel`, {
        headers: { ...forged, Authorization: `Bearer ${token}` },
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessContext: original[index],
      inProcess: false,
      trustedLocal: false,
    });
  }
  expect(arrivals).toBe(2);
  expect(contexts).toEqual(original);
});
