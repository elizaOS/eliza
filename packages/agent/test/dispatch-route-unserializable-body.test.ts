/**
 * Proves a request body the legacy Express shim cannot put on the wire is not
 * silently replaced with an empty one.
 *
 * `buildLegacyShim` streams `JSON.stringify(body)` to legacy `route.handler`
 * code that reads `req`. Before this fix its serialization `catch { return "" }`
 * made a body that fails to stringify (cyclic graph, BigInt, a throwing
 * `toJSON`) indistinguishable from "the caller sent no payload": the handler
 * ran against an empty request and the dispatch still resolved 200, so the
 * caller could not tell a dropped payload from an intentionally empty one.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { expect, it } from "vitest";
import { dispatchRoute } from "../src/api/dispatch-route.ts";

/** Legacy Express-shaped route that records the exact bytes the shim streamed. */
function runtimeRecordingLegacyBodies(seen: string[]): IAgentRuntime {
  const runtime = {} as IAgentRuntime;
  registerHttpPluginRoutes(runtime, {
    name: "legacy-body-probe",
    description: "Echoes the bytes the legacy shim streamed to the handler",
    routes: [
      {
        type: "POST",
        path: "/api/legacy-body-echo",
        rawPath: true,
        handler: async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const text = Buffer.concat(chunks).toString("utf8");
          seen.push(text);
          res.json({ bytes: text.length });
        },
      },
    ],
  });
  return runtime;
}

function dispatchEcho(
  runtime: IAgentRuntime,
  body: unknown,
): ReturnType<typeof dispatchRoute> {
  return dispatchRoute({
    runtime,
    method: "POST",
    path: "/api/legacy-body-echo",
    headers: {},
    body,
    inProcess: true,
    isAuthorized: () => true,
  });
}

it("rejects an unserializable request body instead of dispatching an empty one", async () => {
  const seen: string[] = [];
  const runtime = runtimeRecordingLegacyBodies(seen);
  const circular: Record<string, unknown> = { text: "payload" };
  circular.self = circular;

  let observed: unknown;
  try {
    observed = {
      resolvedWith: await dispatchEcho(runtime, circular),
      handlerSawBody: seen,
    };
  } catch (error) {
    observed = error;
  }

  expect(observed).toMatchObject({
    code: "ROUTE_REQUEST_BODY_UNSERIALIZABLE",
    cause: expect.any(TypeError),
    context: {
      method: "POST",
      path: "/api/legacy-body-echo",
      bodyType: "object",
    },
  });
  // The handler must never run on a request whose payload was silently lost.
  expect(seen).toEqual([]);
});

it("still streams a serializable body and an absent body", async () => {
  const seen: string[] = [];
  const runtime = runtimeRecordingLegacyBodies(seen);

  const serialized = await dispatchEcho(runtime, { text: "payload" });
  expect(serialized?.status).toBe(200);
  expect(seen).toEqual(['{"text":"payload"}']);

  const absent = await dispatchEcho(runtime, undefined);
  expect(absent?.status).toBe(200);
  expect(seen).toEqual(['{"text":"payload"}', ""]);
});
