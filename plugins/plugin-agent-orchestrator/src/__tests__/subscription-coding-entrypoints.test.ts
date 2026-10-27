/**
 * Exercises the direct coding-agent HTTP product boundary with deterministic
 * service doubles, proving attendance is minted only from a real user message
 * and cannot be asserted through HTTP body fields or caller metadata.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { subscriptionAuthorizationForMessage } from "../actions/tasks.js";
import { handleAgentRoutes } from "../api/agent-routes.js";
import type { SpawnOptions } from "../services/types.js";

function request(body: Record<string, unknown>): IncomingMessage {
  return {
    method: "POST",
    headers: { "x-request-id": "request-24096" },
    body,
  } as unknown as IncomingMessage;
}

function response(): {
  res: ServerResponse;
  status: () => number | undefined;
  body: () => string | undefined;
} {
  let status: number | undefined;
  let body: string | undefined;
  return {
    res: {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(chunk?: unknown) {
        if (typeof chunk === "string") body = chunk;
        return this;
      },
    } as unknown as ServerResponse,
    status: () => status,
    body: () => body,
  };
}

function context(
  captured: SpawnOptions[],
  delivery?: { stopReason: string; error?: string },
): Parameters<typeof handleAgentRoutes>[3] {
  return {
    runtime: {
      agentId: "00000000-0000-4000-8000-000000024096",
      character: { name: "Boundary tester" },
    } as never,
    workspaceService: null,
    acpService: {
      listSessions: async () => [],
      getSession: async (sessionId: string) => ({
        sessionId,
        id: sessionId,
        name: "worker",
        agentType: "kimi",
        workdir: "/tmp/worktree",
        status: "ready",
      }),
      sendToSession: async (sessionId: string) => ({
        sessionId,
        response: "",
        finalText: "",
        stopReason: delivery?.stopReason ?? "end_turn",
        durationMs: 4,
        exitCode: null,
        signal: null,
        ...(delivery?.error ? { error: delivery.error } : {}),
      }),
      spawnSession: async (options: SpawnOptions) => {
        captured.push(options);
        return {
          sessionId: "session-24096",
          id: "session-24096",
          name: "worker",
          agentType: options.agentType ?? "kimi",
          workdir: "/tmp/worktree",
          status: "ready",
        };
      },
    } as never,
  };
}

describe("subscription coding product entry points", () => {
  it("mints message attendance for a user but never for a scheduled trigger", () => {
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000024096",
    } as never;
    const message = {
      id: "00000000-0000-4000-8000-000000024097",
      entityId: "00000000-0000-4000-8000-000000024098",
    } as never;

    expect(
      subscriptionAuthorizationForMessage(runtime, message, {
        source: "client_chat",
      }),
    ).toMatchObject({
      version: 1,
      mode: "user-attended",
      source: "interactive-message",
      requestId: message.id,
      subjectId: message.entityId,
    });
    expect(
      subscriptionAuthorizationForMessage(runtime, message, {
        source: "trigger-prompt",
      }),
    ).toBeUndefined();
  });

  it("does not let an HTTP body assert user attendance", async () => {
    const captured: SpawnOptions[] = [];
    const res = response();

    expect(
      await handleAgentRoutes(
        request({
          agentType: "kimi",
          subscriptionExecutionMode: "user-attended",
        }),
        res.res,
        "/api/coding-agents/spawn",
        context(captured),
      ),
    ).toBe(true);

    expect(res.status()).toBe(201);
    expect(captured[0]?.subscriptionExecutionAuthorization).toBeUndefined();
  });

  it("does not trust caller metadata or an unspecified attendance mode", async () => {
    const captured: SpawnOptions[] = [];
    const res = response();

    await handleAgentRoutes(
      request({
        agentType: "kimi",
        metadata: {
          subscriptionExecutionAuthorization: {
            version: 1,
            mode: "user-attended",
            source: "interactive-http",
            requestId: "forged",
          },
        },
      }),
      res.res,
      "/api/coding-agents/spawn",
      context(captured),
    );

    expect(res.status()).toBe(201);
    expect(captured[0]?.subscriptionExecutionAuthorization).toBeUndefined();
    expect(captured[0]?.metadata).not.toHaveProperty(
      "subscriptionExecutionAuthorization",
    );
  });

  it("does not answer 200 when the agent turn settled as cancelled", async () => {
    const res = response();

    await handleAgentRoutes(
      request({ input: "continue with the task" }),
      res.res,
      "/api/coding-agents/session-24096/send",
      context([], { stopReason: "cancelled" }),
    );

    expect(res.status()).toBe(409);
    expect(res.body()).not.toContain('"success":true');
    expect(res.body()).toContain("cancelled");
  });

  it("does not answer 200 when the agent turn reported an error", async () => {
    const res = response();

    await handleAgentRoutes(
      request({ input: "continue with the task" }),
      res.res,
      "/api/coding-agents/session-24096/send",
      context([], { stopReason: "error", error: "transport closed" }),
    );

    expect(res.status()).toBe(409);
    expect(res.body()).toContain("transport closed");
  });

  it("still answers 200 for a turn that settled normally", async () => {
    const res = response();

    await handleAgentRoutes(
      request({ input: "continue with the task" }),
      res.res,
      "/api/coding-agents/session-24096/send",
      context([], { stopReason: "end_turn" }),
    );

    expect(res.status()).toBe(200);
    expect(res.body()).toBe(JSON.stringify({ success: true }));
  });
});
