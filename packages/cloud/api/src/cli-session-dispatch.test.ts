/**
 * Worker-entry wiring for the thin CLI-session shell (#22948): the create POST
 * and poll GET must be answered before full-app bootstrap, marked with the
 * thin-path header. The negative side (complete never matches) is pinned in
 * cli-session-paths.test.ts, without forcing a full-app import here.
 */
import { describe, expect, mock, test } from "bun:test";

const redactString = (_value: string | null | undefined): string =>
  "[REDACTED]";
const redact = {
  txHash: redactString,
  id: redactString,
  orgId: redactString,
  userId: redactString,
  paymentId: redactString,
  trackId: redactString,
  ip: redactString,
  address: redactString,
  context: (_context: Record<string, unknown>): Record<string, unknown> => ({}),
};

mock.module("@/lib/services/cli-auth-sessions", () => ({
  cliAuthSessionsService: {
    createSession: async (sessionId: string) => ({
      session_id: sessionId,
      status: "pending",
      expires_at: new Date("2026-08-20T12:00:00.000Z"),
    }),
    getActiveSession: async () => null,
    getAndClearApiKey: async () => ({
      status: "unavailable",
      reason: "consumed",
    }),
    acknowledgeConsumedCredential: async () => true,
    revokeConsumedCredential: async () => true,
  },
  looksLikeCliAuthSessionId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

mock.module("@/lib/utils/logger", () => ({
  redact,
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    redact,
  },
}));

const worker = (await import("./index")).default;

import type { AppEnv } from "@/types/cloud-worker-env";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const env = {
  ENVIRONMENT: "test",
  NODE_ENV: "test",
  REDIS_RATE_LIMITING: "false",
  BLOB: {},
} as unknown as AppEnv["Bindings"];

describe("thin CLI-session dispatch (#22948)", () => {
  test("answers the create POST on the thin path before full-app bootstrap", async () => {
    const res = await worker.fetch(
      new Request("https://api.example.test/api/auth/cli-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
      executionCtx,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Eliza-Cli-Session-Path")).toBe("thin");
    expect(res.headers.get("Server-Timing")).toMatch(
      /entry_dispatch;dur=\d+(?:\.\d+)?/,
    );
    expect(res.headers.get("Server-Timing")).toContain(
      "cli_session_module_init",
    );
    expect(res.headers.get("Server-Timing")).not.toContain("full_app_dispatch");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  test("answers the poll GET on the thin path", async () => {
    const res = await worker.fetch(
      new Request(
        "https://api.example.test/api/auth/cli-session/bbbbbbbb-2222-4333-8444-cccccccccccc",
      ),
      env,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Eliza-Cli-Session-Path")).toBe("thin");
    expect(res.headers.get("Server-Timing")).not.toContain(
      "cli_session_module_init",
    );
  });

  test.each(["PATCH", "DELETE"])(
    "answers %s credential lifecycle requests on the thin path",
    async (method) => {
      const res = await worker.fetch(
        new Request(
          "https://api.example.test/api/auth/cli-session/bbbbbbbb-2222-4333-8444-cccccccccccc",
          {
            method,
            headers: { Authorization: "Bearer eliza_cli_exact" },
          },
        ),
        env,
        executionCtx,
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("X-Eliza-Cli-Session-Path")).toBe("thin");
      expect(res.headers.get("Server-Timing")).not.toContain(
        "full_app_dispatch",
      );
    },
  );
});
