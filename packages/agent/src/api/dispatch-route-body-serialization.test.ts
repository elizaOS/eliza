import type { IAgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { expect, it } from "vitest";
import { dispatchRoute } from "./dispatch-route";

/**
 * `packages/agent/README.md` — the runtime dispatches plugin routes over both
 * HTTP and IPC, and legacy Express-shaped handlers receive a synthetic
 * `IncomingMessage` whose body is the serialized request payload.
 *
 * A payload that `JSON.stringify` cannot represent (circular reference,
 * BigInt) used to degrade into an *empty* request stream. A handler that
 * re-reads the raw body then ran against zero bytes, so the serialization
 * fault reached the transport as "the client sent no payload" — a 200 with an
 * empty result instead of a visible failure. The shim must refuse to build a
 * request it cannot faithfully represent.
 */
it("rejects a legacy dispatch whose body cannot be serialized instead of dispatching it as empty", async () => {
  const runtime = {} as IAgentRuntime;
  let handlerRan = false;
  registerHttpPluginRoutes(runtime, {
    name: "body-serialization-probe",
    description:
      "Observes whether an unserializable request body reaches the handler",
    routes: [
      {
        type: "POST",
        path: "/api/body-serialization-probe",
        rawPath: true,
        handler: async (req, res) => {
          handlerRan = true;
          let receivedBytes = 0;
          for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
            receivedBytes += chunk.length;
          }
          res.json({ receivedBytes });
        },
      },
    ],
  });

  const circular: Record<string, unknown> = { topic: "probe" };
  circular.self = circular;

  await expect(
    dispatchRoute({
      runtime,
      method: "POST",
      path: "/api/body-serialization-probe",
      headers: {},
      body: circular,
      inProcess: false,
      isAuthorized: () => true,
      isTrustedLocal: () => false,
    }),
  ).rejects.toThrow(/not JSON-serializable/);

  // The handler must never observe a fabricated empty body.
  expect(handlerRan).toBe(false);
});
