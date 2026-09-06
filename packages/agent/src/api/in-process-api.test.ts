import { describe, expect, it } from "vitest";
import type { DispatchRouteArgs } from "./dispatch-route.ts";
import { dispatchApiRoute, registerInProcessApi } from "./in-process-api.ts";
import { createRouteKernel } from "./route-kernel.ts";

function request(runtime: object): DispatchRouteArgs {
  return {
    runtime: runtime as DispatchRouteArgs["runtime"],
    method: "POST",
    path: "/v1/chat/completions",
    headers: { authorization: "Bearer valid" },
    body: '{"messages":[{"role":"user","content":"hello"}]}',
    inProcess: true,
    isAuthorized: () => true,
  };
}

describe("full API dispatch over local IPC", () => {
  it("keeps kernel authentication, body/query bytes and streaming events", async () => {
    const runtime = {};
    const chunks: Buffer[] = [];
    let finished = false;
    let receivedBody = "";
    const unregister = registerInProcessApi(
      runtime,
      createRouteKernel({
        async dispatch(req, res) {
          if (req.headers.authorization !== "Bearer valid") {
            res.writeHead(401, { "content-type": "application/json" });
            res.end('{"error":"Unauthorized"}');
            return;
          }
          expect(req.url).toBe("/v1/chat/completions?tag=one&tag=two");
          expect(req.socket.remoteAddress).toBe("127.0.0.1");
          for await (const chunk of req) receivedBody += chunk.toString();
          await new Promise((resolve) => setImmediate(resolve));
          expect(req.destroyed).toBe(false);
          expect(req.socket.destroyed).toBe(false);
          res.on("finish", () => {
            finished = true;
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          expect(res.headersSent).toBe(true);
          res.write("data: first\n\n");
          await Promise.resolve();
          res.end("data: [DONE]\n\n");
        },
        translateFailure(error) {
          throw error;
        },
      }),
    );
    try {
      const responseStatuses: number[] = [];
      const denied = await dispatchApiRoute({
        ...request(runtime),
        headers: {},
        onHeaders(status) {
          responseStatuses.push(status);
        },
      });
      expect(responseStatuses).toEqual([401]);
      expect(denied.status).toBe(401);
      const result = await dispatchApiRoute({
        ...request(runtime),
        query: { tag: ["one", "two"] },
        onChunk(chunk) {
          chunks.push(chunk);
        },
      });
      expect(result.status).toBe(200);
      expect(receivedBody).toBe(request(runtime).body);
      expect(Buffer.concat(chunks).toString()).toBe(
        "data: first\n\ndata: [DONE]\n\n",
      );
      expect(finished).toBe(true);
    } finally {
      unregister();
    }
    expect((await dispatchApiRoute(request(runtime))).status).toBe(503);
  });

  it("rejects untrusted transports and never fabricates an unfinished response", async () => {
    const runtime = {};
    let calls = 0;
    const kernel = createRouteKernel({
      async dispatch() {
        calls++;
      },
      translateFailure(error) {
        throw error;
      },
    });
    const unregister = registerInProcessApi(runtime, kernel);
    try {
      expect(
        (await dispatchApiRoute({ ...request(runtime), inProcess: false }))
          .status,
      ).toBe(401);
      expect(
        (
          await dispatchApiRoute({
            ...request(runtime),
            isAuthorized: () => false,
          })
        ).status,
      ).toBe(401);
      expect(calls).toBe(0);
      await expect(dispatchApiRoute(request(runtime))).rejects.toThrow(
        "did not finish",
      );
    } finally {
      unregister();
    }
  });
});
