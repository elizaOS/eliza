/**
 * A real conversation turn that fails on an Eliza Cloud 429 must deliver the
 * typed wait to the client as `terminalFailure.rateLimit`, on both the JSON
 * and the SSE route. A temporary limit is waited out once and the same request
 * re-sent before the turn fails; a used-up allowance or spent credit is not.
 * Each refused call is one Cloud upload, not one per registered model type.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseChatTerminalFailure } from "@elizaos/contracts";
import { createCharacter, type IAgentRuntime, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import {
  handleResponseHandler,
  handleTextLarge,
  handleTextSmall,
} from "../../../plugins/plugin-elizacloud/src/models/text.ts";
import { startApiServer } from "../src/api/server.ts";

/**
 * `uploads` is the Cloud requests one refused Stage 1 step makes: the refused
 * call, plus the turn's single re-send after `resendWaitMs` when the limit is
 * temporary. `headers` are the refusal's own; a 429 sends `Retry-After: 3`
 * unless it names none.
 */
type Refusal = {
  status: number;
  kind: string;
  transient: boolean;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
  expected?: Record<string, unknown>;
  uploads: 1 | 2;
  resendWaitMs?: number;
};

const PLAN_BUCKET: Refusal = {
  status: 429,
  kind: "rate_limited",
  transient: true,
  uploads: 2,
  resendWaitMs: 2_400,
  body: {
    error: {
      message: "Too many requests in a short time for this plan.",
      type: "rate_limit_error",
      code: "rate_limited",
      retryAfterSeconds: 3,
      retryAfterMs: 2_400,
      plan: { id: "pro" },
      limit: { bucket: "burst", capacity: 5, refillPerSecond: 1 },
    },
  },
  expected: {
    kind: "rate_limited",
    retryAfterMs: 2_400,
    planId: "pro",
    scope: "burst",
  },
};

// What the gateway answers today when the provider refuses a request: no
// wait in the body and no Retry-After header. The turn waits its own capped
// 5 s before the re-send, and the client gets no typed wait.
const PROVIDER_REFUSAL: Refusal = {
  status: 429,
  kind: "rate_limited",
  transient: true,
  uploads: 2,
  resendWaitMs: 5_000,
  headers: {},
  body: {
    error: {
      message: "Rate limit exceeded. Please try again later.",
      type: "rate_limit_error",
    },
  },
};

// The same refusal once the gateway sizes the wait from the refused request.
const SIZED_PROVIDER_REFUSAL: Refusal = {
  status: 429,
  kind: "rate_limited",
  transient: true,
  uploads: 2,
  resendWaitMs: 1_500,
  headers: {},
  body: {
    error: {
      message: "Rate limit exceeded. Please try again later.",
      type: "rate_limit_error",
      retryAfterMs: 1_500,
    },
  },
  expected: { kind: "rate_limited", retryAfterMs: 1_500 },
};

// A used-up period allowance: the wait is capped, the reset time is not.
const PERIOD_ALLOWANCE: Refusal = {
  status: 429,
  kind: "rate_limited",
  transient: true,
  uploads: 1,
  body: {
    error: {
      code: "allowance_exhausted",
      service: "inference",
      resetsAt: "2026-11-01T00:00:00.000Z",
      retryAfterSeconds: 259_200,
      capacity: 1,
    },
  },
  expected: {
    kind: "rate_limited",
    retryAfterMs: 60 * 60 * 1000,
    scope: "period",
    resetAt: "2026-11-01T00:00:00.000Z",
    resetAfterSeconds: 259_200,
  },
};

// Cloud inference refuses a used-up allowance as 402 insufficient_quota
// (chat/completions route). It stays a non-retried credits failure that
// carries the reset time.
const ALLOWANCE_402_RESETS_AT = new Date(
  Date.now() + 2 * 86_400_000,
).toISOString();
const INFERENCE_ALLOWANCE_402: Refusal = {
  status: 402,
  kind: "insufficient_credits",
  transient: false,
  uploads: 1,
  body: {
    error: {
      message:
        "Plan allowance is used up for this period. Nothing is purchased automatically.",
      type: "insufficient_quota",
      code: "allowance_exhausted",
      resetsAt: ALLOWANCE_402_RESETS_AT,
    },
  },
  expected: {
    kind: "rate_limited",
    retryAfterMs: 60 * 60 * 1000,
    scope: "period",
    resetAt: ALLOWANCE_402_RESETS_AT,
    resetAfterSeconds: expect.any(Number),
  },
};

it.each([
  ["/messages", "plan bucket", PLAN_BUCKET],
  ["/messages/stream", "plan bucket", PLAN_BUCKET],
  ["/messages", "provider refusal with no wait", PROVIDER_REFUSAL],
  ["/messages", "provider refusal with a sized wait", SIZED_PROVIDER_REFUSAL],
  [
    "/messages/stream",
    "provider refusal with a sized wait",
    SIZED_PROVIDER_REFUSAL,
  ],
  ["/messages", "period allowance", PERIOD_ALLOWANCE],
  ["/messages/stream", "period allowance", PERIOD_ALLOWANCE],
  ["/messages", "inference allowance 402", INFERENCE_ALLOWANCE_402],
  ["/messages/stream", "inference allowance 402", INFERENCE_ALLOWANCE_402],
] as const)(
  "delivers the Cloud refusal and its reset on %s (%s)",
  async (
    route,
    _refusal,
    {
      status,
      kind,
      transient,
      headers: refusalHeaders,
      body: cloudBody,
      expected: EXPECTED_RATE_LIMIT,
      uploads,
      resendWaitMs,
    },
  ) => {
    const directory = await mkdtemp(path.join(tmpdir(), "cloud-rate-limit-"));
    const cloudRequests: { sent: string; at: number }[] = [];
    const cloud = createServer((req, res) => {
      cloudRequests.push({
        sent: `${req.headers["x-eliza-model-type"]}:${req.headers["x-eliza-llm-purpose"]}`,
        at: Date.now(),
      });
      req.resume();
      req.on("end", () => {
        // Cloud's 402 allowance refusal sends no Retry-After header.
        res.writeHead(status, {
          "content-type": "application/json",
          ...(refusalHeaders ?? (status === 429 ? { "Retry-After": "3" } : {})),
        });
        res.end(JSON.stringify(cloudBody));
      });
    });
    await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
    const cloudSettings: Record<string, string> = {
      ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
      ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/api/v1`,
    };
    const cloudRuntime = {
      character: { name: "CloudRateLimit", bio: [] },
      getSetting: (key: string) => cloudSettings[key],
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_API_TOKEN: randomUUID(),
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
    }))
      vi.stubEnv(key, value);
    const runtime = createSQLiteTestRuntime({
      plugins: [createAssistantPlugin()],
      character: createCharacter({ name: "CloudRateLimit" }),
      logLevel: "fatal",
      enableAutonomy: false,
    });
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      await runtime.initialize();
      for (const [type, handler] of [
        [ModelType.RESPONSE_HANDLER, handleResponseHandler],
        [ModelType.TEXT_LARGE, handleTextLarge],
        [ModelType.TEXT_SMALL, handleTextSmall],
      ] as const)
        runtime.registerModel(
          type,
          (_runtime, params) => handler(cloudRuntime, params as never),
          "elizaOSCloud",
          100,
        );
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const origin = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: `Bearer ${process.env.ELIZA_API_TOKEN}`,
        "content-type": "application/json",
      };
      const create = await fetch(`${origin}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Rate limited" }),
      });
      const created = await create.json();
      expect(create.status, JSON.stringify(created)).toBe(200);
      const turnUrl = `${origin}/api/conversations/${created.conversation.id}${route}`;
      const turnBody = JSON.stringify({
        text: "Answer this test request.",
        clientMessageId: randomUUID(),
      });
      const response = await fetch(turnUrl, {
        method: "POST",
        headers,
        body: turnBody,
      });
      expect(response.status).toBe(200);
      let payload: Record<string, unknown>;
      if (route === "/messages") {
        payload = await response.json();
      } else {
        const events = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
        const done = events.find((event) => event.type === "done");
        expect(done, JSON.stringify(events)).toBeDefined();
        payload = done as Record<string, unknown>;
      }
      expect(payload.failureKind, JSON.stringify(payload)).toBe(kind);
      // The status stays 429 for the client: a typed, transient rate limit.
      expect(payload.terminalFailure).toMatchObject({ kind, transient });
      if (EXPECTED_RATE_LIMIT) {
        expect(payload.terminalFailure).toMatchObject({
          rateLimit: EXPECTED_RATE_LIMIT,
        });
      } else {
        // A refusal that reports no wait gets none invented for the client.
        expect(payload.terminalFailure).not.toHaveProperty("rateLimit");
      }
      // The client-side contract parser keeps the same typed field.
      expect(
        parseChatTerminalFailure(payload.terminalFailure)?.rateLimit,
      ).toEqual(EXPECTED_RATE_LIMIT);
      // One refused Stage 1 call is one Cloud upload. The three Cloud
      // registrations here send one model, so the runtime's failover does not
      // upload a 429 again through TEXT_SMALL and TEXT_LARGE. A temporary
      // limit is uploaded once more after its wait; nothing else is retried
      // and the 429 adds no apology call.
      expect(cloudRequests.map((request) => request.sent)).toEqual(
        Array(uploads).fill("RESPONSE_HANDLER:should_respond"),
      );
      if (resendWaitMs !== undefined) {
        // The re-send waits the reported time, not the turn's 5 s cap, which
        // applies only when the refusal reports no wait.
        const waited = cloudRequests[1].at - cloudRequests[0].at;
        expect(waited).toBeGreaterThanOrEqual(resendWaitMs - 50);
        if (resendWaitMs < 5_000) expect(waited).toBeLessThan(5_000);
      }
      // Only bounded fields reach the client, never other body fields.
      expect(JSON.stringify(payload)).not.toContain("capacity");
      // An idempotent replay keeps the typed failure but not the stale wait.
      const callsBeforeReplay = cloudRequests.length;
      const replay = await fetch(turnUrl, {
        method: "POST",
        headers,
        body: turnBody,
      });
      expect(replay.status).toBe(200);
      const replayText = await replay.text();
      expect(replayText).toContain(`"kind":"${kind}"`);
      expect(replayText).not.toContain("retryAfterMs");
      expect(cloudRequests.length).toBe(callsBeforeReplay);
    } finally {
      if (server) await server.close();
      await runtime.stop();
      await new Promise<void>((resolve) => cloud.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
