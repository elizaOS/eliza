/**
 * Trusted runtime tests exercise exact action dispatch and provenance while
 * replacing only the production plugin handler behind the boundary.
 */

import {
  type Action,
  type AgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../server-utils.js";
import {
  executeTrustedRuntimeAction,
  parseTrustedRuntimeActionRequest,
  TrustedRuntimeActionHttpError,
  TRUSTED_RUNTIME_ACTION_SCHEMA,
} from "../trusted-runtime-action-handler.js";

const TOKEN_IDEMPOTENCY =
  "lifeops-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function requestBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: TRUSTED_RUNTIME_ACTION_SCHEMA,
    task_id: "scenario-1:run-1",
    action: {
      name: "CALENDAR_SOURCES",
      parameters: { operation: "list" },
    },
    idempotency_key: TOKEN_IDEMPOTENCY,
    risk: "read",
    requested_at: new Date().toISOString(),
    ...overrides,
  };
}

function runtimeWithAction(action: Action): AgentRuntime {
  return {
    agentId: stringToUuid("trusted-runtime-test-agent"),
    getAllActions: () => [action],
    composeState: vi.fn(async () => ({
      values: {},
      data: {},
      text: "",
    })),
    logger: {
      error: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

describe("trusted runtime action boundary", () => {
  it("dispatches exact parameters to the registered native action and preserves structured state", async () => {
    const handler = vi.fn(async (_runtime, _message, _state, options) => ({
      success: true,
      text: "Calendar source state is partial.",
      data: {
        snapshot: {
          state: "partial",
          sources: [
            {
              key: {
                provider: "google",
                side: "owner",
                grantId: "grant-a",
                connectorAccountId: "account-a",
                calendarId: "primary",
              },
              health: {
                key: {
                  provider: "google",
                  side: "owner",
                  grantId: "grant-a",
                  connectorAccountId: "account-a",
                  calendarId: "primary",
                },
                accessRole: "owner",
                visibility: "details",
                status: "stale",
                syncedAt: null,
                error: null,
              },
            },
          ],
          observedAt: "2026-07-27T12:00:00.000Z",
        },
      },
      debugOptions: options,
    }));
    const action: Action = {
      name: "CALENDAR_SOURCES",
      description: "List source state.",
      validate: vi.fn(async () => true),
      handler,
      tags: ["domain:calendar", "capability:read"],
    };
    const runtime = runtimeWithAction(action);
    const request = parseTrustedRuntimeActionRequest(requestBody());

    const result = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["CALENDAR_SOURCES"]),
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
        prepareSession: async () => {},
      },
      request,
    );

    expect(result).toMatchObject({
      schema: TRUSTED_RUNTIME_ACTION_SCHEMA,
      ok: true,
      action: "CALENDAR_SOURCES",
      idempotency_key: TOKEN_IDEMPOTENCY,
      runtime: {
        native_runtime_class: "@elizaos/core.AgentRuntime",
        native_runtime_api: "Action.handler",
        stand_in: false,
        release_evidence: true,
      },
      result: {
        success: true,
        data: {
          actionName: "CALENDAR_SOURCES",
          snapshot: { state: "partial" },
        },
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[3]).toMatchObject({
      parameters: {
        operation: "list",
        idempotencyKey: TOKEN_IDEMPOTENCY,
      },
    });
  });

  it("rejects an action outside the process allowlist before validation", async () => {
    const validate = vi.fn(async () => true);
    const action: Action = {
      name: "CALENDAR_SOURCES",
      description: "List source state.",
      validate,
      handler: vi.fn(async () => ({ success: true })),
    };

    await expect(
      executeTrustedRuntimeAction(
        {
          runtime: runtimeWithAction(action),
          bearerToken: "x".repeat(32),
          allowedActions: new Set(["CALENDAR"]),
          resolveSession: (taskId) =>
            createSession(taskId, "lifeops_trusted_runtime"),
          prepareSession: async () => {},
        },
        parseTrustedRuntimeActionRequest(requestBody()),
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      publicMessage: "action is not in the trusted runtime allowlist",
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied idempotency key that conflicts with the envelope", () => {
    expect(() =>
      parseTrustedRuntimeActionRequest(
        requestBody({
          action: {
            name: "CALENDAR_SOURCES",
            parameters: {
              operation: "list",
              idempotencyKey:
                "lifeops-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            },
          },
        }),
      ),
    ).toThrow(TrustedRuntimeActionHttpError);
  });

  it("refuses legacy handlers that return no structured success result", async () => {
    const action: Action = {
      name: "CALENDAR_SOURCES",
      description: "List source state.",
      validate: vi.fn(async () => true),
      handler: vi.fn(async () => undefined),
    };

    await expect(
      executeTrustedRuntimeAction(
        {
          runtime: runtimeWithAction(action),
          bearerToken: "x".repeat(32),
          allowedActions: new Set(["CALENDAR_SOURCES"]),
          resolveSession: (taskId) =>
            createSession(taskId, "lifeops_trusted_runtime"),
          prepareSession: async () => {},
        },
        parseTrustedRuntimeActionRequest(requestBody()),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
