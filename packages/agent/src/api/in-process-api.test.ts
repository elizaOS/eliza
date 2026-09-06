import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
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
  it("uses the production server registration, authentication and chat validation across runtime replacement and close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eliza-ipc-kernel-"));
    vi.stubEnv("ELIZA_STATE_DIR", root);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(root, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(root, "eliza.json"));
    vi.stubEnv("ELIZA_API_TOKEN", "valid");
    vi.stubEnv("ELIZA_API_AUTH_TOKEN", "");
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
    vi.stubEnv("ELIZA_DEVICE_BRIDGE_ENABLED", "0");
    const runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
    const replacement = new AgentRuntime({ logLevel: "fatal", plugins: [] });
    let api:
      | Awaited<ReturnType<typeof import("./server.ts").startApiServer>>
      | undefined;
    try {
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
      await replacement.initialize({
        allowNoDatabase: true,
        skipMigrations: true,
      });
      const { startApiServer } = await import("./server.ts");
      expect((await dispatchApiRoute(request(runtime))).status).toBe(503);
      api = await startApiServer({
        runtime,
        skipListen: true,
        skipDeferredStartupWork: true,
      });
      const deniedHeaders: Record<string, string>[] = [
        {},
        { authorization: "Bearer wrong" },
      ];
      for (const headers of deniedHeaders) {
        expect(
          (await dispatchApiRoute({ ...request(runtime), headers })).status,
        ).toBe(401);
      }
      const invalidChat = await dispatchApiRoute({
        ...request(runtime),
        body: "{}",
      });
      expect(invalidChat.status).toBe(400);
      expect(invalidChat.body).toMatchObject({
        error: {
          type: "invalid_request_error",
          message:
            "messages must be an array containing at least one user message",
        },
      });
      api.updateRuntime(replacement);
      expect((await dispatchApiRoute(request(runtime))).status).toBe(503);
      expect(
        (await dispatchApiRoute({ ...request(replacement), body: "{}" }))
          .status,
      ).toBe(400);
      await api.close();
      api = undefined;
      expect((await dispatchApiRoute(request(replacement))).status).toBe(503);
    } finally {
      await api?.close();
      for (const current of [runtime, replacement]) {
        await current.stop({ fast: true });
        await current.close();
      }
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

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
