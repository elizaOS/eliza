import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, get } from "node:http";
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
import { expect, it, vi } from "vitest";
import { handleAccountsRoutes } from "../src/api/accounts-routes.ts";

interface HeartbeatCase {
  goal: number;
  ticks: number;
  closed: boolean;
  dataFrames: number;
}
const cases: HeartbeatCase[] = process.env.ELIZA_OAUTH_STATUS_MODEL_CASES
  ? JSON.parse(readFileSync(process.env.ELIZA_OAUTH_STATUS_MODEL_CASES, "utf8"))
  : [1, 2].map((goal) => ({ goal, ticks: goal, closed: true, dataFrames: 2 }));

it.each(cases)(
  "keeps pending OAuth alive for $goal comment ticks then closes on cancellation",
  async (model) => {
    const stateDir = await mkdtemp(join(tmpdir(), "oauth-status-sse-"));
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    let sessionId = "";
    const frames: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void handleAccountsRoutes({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        json: (response, data, status) =>
          sendJson(response, data, status ?? 200),
        error: (response, message, status) =>
          sendJsonError(response, message, status ?? 500),
        readJsonBody,
        state: { config: {} as ElizaConfig, runtime: null },
        saveConfig: () => {
          throw new Error("Read-only OAuth status must not save configuration");
        },
      }).catch((error) => {
        res.destroy(error);
      });
    });
    try {
      const flow = await startAnthropicOAuthFlow({
        label: "status-sse-model",
        storagePolicy: createRuntimeAccountStoragePolicy(resolveStateDir()),
      });
      sessionId = flow.sessionId;
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert(address && typeof address !== "string");
      let ended = false;
      await new Promise<void>((resolve, reject) => {
        const request = get(
          `http://127.0.0.1:${address.port}/api/accounts/anthropic-subscription/oauth/status?sessionId=${encodeURIComponent(sessionId)}`,
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toBe("text/event-stream");
            let pending = "";
            res.on("data", (chunk: Buffer) => {
              pending += chunk.toString("utf8");
              let boundary = pending.indexOf("\n\n");
              while (boundary >= 0) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                if (frame.trim()) frames.push(frame);
                if (
                  frames.filter((value) => value.startsWith(": heartbeat"))
                    .length === model.goal
                ) {
                  cancelFlow(sessionId, "status-sse model cancellation");
                }
                boundary = pending.indexOf("\n\n");
              }
            });
            res.once("end", () => {
              ended = true;
              resolve();
            });
            res.once("error", reject);
          },
        );
        request.setTimeout(20_000, () =>
          request.destroy(new Error("OAuth heartbeat or closure missing")),
        );
        request.once("error", reject);
      });
      const dataFrames = frames.filter((frame) => frame.startsWith("data:"));
      const comments = frames.filter((frame) =>
        frame.startsWith(": heartbeat"),
      );
      expect(comments.length).toBe(model.ticks);
      expect(dataFrames.length).toBe(model.dataFrames);
      expect(dataFrames[0]).toContain('"status":"pending"');
      expect(dataFrames[1]).toContain('"status":"cancelled"');
      expect(ended).toBe(model.closed);
    } finally {
      if (sessionId) cancelFlow(sessionId, "status-sse fixture cleanup");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(stateDir, { recursive: true, force: true });
    }
  },
  45_000,
);
