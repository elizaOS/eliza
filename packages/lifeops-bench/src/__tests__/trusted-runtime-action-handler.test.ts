/**
 * Trusted runtime tests exercise exact action dispatch and provenance while
 * replacing only the production plugin handler behind the boundary.
 */

import { type Action, type AgentRuntime, stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../server-utils.js";
import {
  executeTrustedRuntimeAction,
  parseTrustedRuntimeActionRequest,
  parseTrustedRuntimeEvidenceProvenance,
  TRUSTED_RUNTIME_ACTION_SCHEMA,
  TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
  TrustedRuntimeActionHttpError,
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
        release_evidence: false,
        evidence_provenance: {
          schema: TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
          tier: "local_nonpublishable",
          publishable: false,
          configuration_basis: "default_local_configuration",
          provider: null,
          boundary: null,
          account_identity_sha256: null,
          provider_readback: "not_applicable",
        },
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

  it("keeps configured provider provenance nonpublishable without verified readback", async () => {
    const action: Action = {
      name: "CALENDAR_SOURCES",
      description: "List provider source state.",
      validate: vi.fn(async () => true),
      handler: vi.fn(async () => ({
        success: true,
        data: { snapshot: { state: "healthy" } },
      })),
    };
    const evidenceProvenance = parseTrustedRuntimeEvidenceProvenance({
      ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
      ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
      ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY: "sandbox_connector",
      ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256: "a".repeat(64),
    });

    const response = await executeTrustedRuntimeAction(
      {
        runtime: runtimeWithAction(action),
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["CALENDAR_SOURCES"]),
        evidenceProvenance,
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
        prepareSession: async () => {},
      },
      parseTrustedRuntimeActionRequest(requestBody()),
    );

    expect(response.runtime).toEqual({
      native_runtime_class: "@elizaos/core.AgentRuntime",
      native_runtime_api: "Action.handler",
      transport: "trusted_runtime_http",
      stand_in: false,
      release_evidence: false,
      evidence_provenance: evidenceProvenance,
      action_tags: [],
    });
    expect(evidenceProvenance.provider_readback).toBe("not_verified");
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

  it("strips action-supplied native state reserved for server-owned capture", async () => {
    const action: Action = {
      name: "CALENDAR_SOURCES",
      description: "Attempt to smuggle trusted state.",
      validate: vi.fn(async () => true),
      handler: vi.fn(async () => ({
        success: true,
        data: {
          terminalSnapshot: { forged: true },
          trustedFinalState: { forged: true },
          trustedParentContractState: { forged: true },
          ordinaryResult: "preserved",
        },
      })),
    };

    const response = await executeTrustedRuntimeAction(
      {
        runtime: runtimeWithAction(action),
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["CALENDAR_SOURCES"]),
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
        prepareSession: async () => {},
      },
      parseTrustedRuntimeActionRequest(requestBody()),
    );
    const result = response.result as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect(data.ordinaryResult).toBe("preserved");
    expect(data.terminalSnapshot).toBeUndefined();
    expect(data.trustedFinalState).toBeUndefined();
    expect(data.trustedParentContractState).toBeUndefined();
  });

  it("strips evaluator-visible state reintroduced by an action data toJSON hook", async () => {
    const action: Action = {
      name: "CALENDAR_SOURCES",
      description: "Attempt to serialize forged trusted state.",
      validate: vi.fn(async () => true),
      handler: vi.fn(async () => ({
        success: true,
        data: {
          ordinaryResult: "before serialization",
          toJSON: () => ({
            ordinaryResult: "preserved after serialization",
            terminalSnapshot: { forged: true },
            trustedFinalState: { forged: true },
            trustedParentContractState: { forged: true },
            nestedDomainState: {
              terminalSnapshot: { domainValue: "not evaluator-visible" },
            },
          }),
        },
      })),
    };

    const response = await executeTrustedRuntimeAction(
      {
        runtime: runtimeWithAction(action),
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["CALENDAR_SOURCES"]),
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
        prepareSession: async () => {},
      },
      parseTrustedRuntimeActionRequest(requestBody()),
    );
    const result = response.result as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect(data).toMatchObject({
      actionName: "CALENDAR_SOURCES",
      ordinaryResult: "preserved after serialization",
      nestedDomainState: {
        terminalSnapshot: { domainValue: "not evaluator-visible" },
      },
    });
    expect(data.terminalSnapshot).toBeUndefined();
    expect(data.trustedFinalState).toBeUndefined();
    expect(data.trustedParentContractState).toBeUndefined();
  });
});

describe("trusted runtime evidence provenance", () => {
  it("defaults all local, fixture, and PGlite execution to nonpublishable", () => {
    expect(parseTrustedRuntimeEvidenceProvenance({})).toEqual({
      schema: TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
      tier: "local_nonpublishable",
      publishable: false,
      configuration_basis: "default_local_configuration",
      provider: null,
      boundary: null,
      account_identity_sha256: null,
      provider_readback: "not_applicable",
    });
  });

  it("requires an explicit, complete provider-backed configuration", () => {
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER must be a lowercase provider identifier",
    );
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY must be sandbox_connector or production_connector",
    );
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY: "sandbox_connector",
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256 must be a 64-character SHA-256 digest",
    );
  });

  it("rejects unknown tiers, boundaries, identifiers, and stale provider fields", () => {
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "release",
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER must be local_nonpublishable or provider_backed",
    );
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER requires ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER=provider_backed",
    );
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "Google Calendar",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY: "sandbox_connector",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256: "a".repeat(64),
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER must be a lowercase provider identifier",
    );
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY: "local",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256: "a".repeat(64),
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY must be sandbox_connector or production_connector",
    );
    expect(() =>
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY: "sandbox_connector",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256: "not-a-digest",
      }),
    ).toThrow(
      "ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256 must be a 64-character SHA-256 digest",
    );
  });

  it("surfaces pinned provider provenance without claiming provider readback", () => {
    expect(
      parseTrustedRuntimeEvidenceProvenance({
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_TIER: "provider_backed",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_PROVIDER: "google-calendar",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_BOUNDARY: "sandbox_connector",
        ELIZA_BENCH_TRUSTED_RUNTIME_EVIDENCE_ACCOUNT_SHA256: "A".repeat(64),
      }),
    ).toEqual({
      schema: TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
      tier: "provider_backed",
      publishable: false,
      configuration_basis: "explicit_server_configuration",
      provider: "google-calendar",
      boundary: "sandbox_connector",
      account_identity_sha256: "a".repeat(64),
      provider_readback: "not_verified",
    });
  });
});
