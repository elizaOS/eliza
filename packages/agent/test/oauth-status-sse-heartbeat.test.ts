/**
 * Exercises the real OAuth status SSE route over a real loopback HTTP socket
 * with a real, keyless Anthropic flow that stays pending (nobody completes it).
 *
 * The keepalive contract mirrors the conversation SSE stream: a pending flow
 * sits idle for minutes while the user is on the provider's pages, and an idle
 * L7 proxy (nginx default proxy_read_timeout 60s) cuts a byte-less stream
 * before the terminal state arrives. Comment frames (": heartbeat") keep the
 * connection observably alive without touching the event stream.
 *
 * No mocks of the route under test: real http server, real request/response,
 * real flow registry, real route handler through handleAccountsRoutes.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelFlow,
  createRuntimeAccountStoragePolicy,
  startAnthropicOAuthFlow,
} from "@elizaos/auth/auth";
import { resolveStateDir } from "@elizaos/core";
import { readJsonBody, sendJson, sendJsonError } from "@elizaos/host";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { handleAccountsRoutes } from "../src/api/accounts-routes.ts";

let server: Server;
let port: number;
let stateDir: string;
let sessionId = "";
const frames: { t: number; text: string }[] = [];
let resolveSseClosed: (() => void) | undefined;
const sseClosed = new Promise<void>((resolve) => {
  resolveSseClosed = resolve;
});

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "oauth-status-sse-"));
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);

  const handle = await startAnthropicOAuthFlow({
    label: "status-sse-heartbeat-guard",
    storagePolicy: createRuntimeAccountStoragePolicy(resolveStateDir()),
  });
  sessionId = handle.sessionId;

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleAccountsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      json: (response, data, status) => sendJson(response, data, status ?? 200),
      error: (response, message, status) =>
        sendJsonError(response, message, status ?? 500),
      readJsonBody,
      state: {
        config: {} as ElizaConfig,
        runtime: null,
      },
      saveConfig: () => {
        throw new Error("status-sse guard does not exercise saveConfig");
      },
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      ({ port } = server.address() as AddressInfo);
      resolve();
    });
  });
  server.unref();
});

afterAll(async () => {
  if (sessionId) cancelFlow(sessionId, "status-sse guard cleanup");
  server.close();
  await rm(stateDir, { recursive: true, force: true });
});

it("keeps a pending OAuth status stream alive with comment heartbeat frames", async () => {
  expect(sessionId).not.toBe("");
  const started = Date.now();
  await new Promise<void>((resolve) => {
    const request = get(
      `http://127.0.0.1:${port}/api/accounts/anthropic-subscription/oauth/status?sessionId=${encodeURIComponent(sessionId)}`,
      (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.on("data", (buf: Buffer) => {
          for (const block of buf.toString("utf8").split("\n\n")) {
            if (block.trim()) {
              frames.push({ t: Date.now() - started, text: block });
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", () => resolve());
        // Hold the stream across at least one heartbeat interval after the
        // initial pending replay, then read how the stream kept itself alive.
        setTimeout(() => {
          request.destroy();
          resolveSseClosed?.();
          resolve();
        }, 11_000);
      },
    );
  });
  await sseClosed;

  const dataFrames = frames.filter((frame) => frame.text.startsWith("data:"));
  const heartbeatFrames = frames.filter((frame) =>
    frame.text.startsWith(": heartbeat"),
  );
  // The pending replay still arrives first, exactly once, unchanged.
  expect(dataFrames.length).toBe(1);
  expect(dataFrames[0]?.text).toContain('"status":"pending"');
  // The keepalive contract: comment frames arrive while the flow stays pending.
  expect(heartbeatFrames.length).toBeGreaterThanOrEqual(2);
  for (const frame of heartbeatFrames) {
    expect(frame.t).toBeGreaterThanOrEqual(5_000);
  }
});
