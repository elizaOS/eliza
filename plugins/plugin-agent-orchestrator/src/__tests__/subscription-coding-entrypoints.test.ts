/**
 * Exercises the direct coding-agent HTTP product boundary with deterministic
 * service doubles, proving attendance is minted only for an explicit
 * user-attended request and cannot be supplied through caller metadata.
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
} {
  let status: number | undefined;
  return {
    res: {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end() {
        return this;
      },
    } as unknown as ServerResponse,
    status: () => status,
  };
}

function context(
  captured: SpawnOptions[],
): Parameters<typeof handleAgentRoutes>[3] {
  return {
    runtime: {
      agentId: "00000000-0000-4000-8000-000000024096",
      character: { name: "Boundary tester" },
    } as never,
    workspaceService: null,
    acpService: {
      listSessions: async () => [],
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
    ).toEqual({
      version: 1,
      mode: "user-attended",
      source: "interactive-message",
      requestId: message.id,
    });
    expect(
      subscriptionAuthorizationForMessage(runtime, message, {
        source: "trigger-prompt",
      }),
    ).toBeUndefined();
  });

  it("mints HTTP attendance proof from an explicit interactive request", async () => {
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
    expect(captured[0]?.subscriptionExecutionAuthorization).toEqual({
      version: 1,
      mode: "user-attended",
      source: "interactive-http",
      requestId: "request-24096",
    });
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
});
