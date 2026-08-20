/** Tests the untrusted action-result boundary and resumable workspace intent. */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { ChatActionResultSummary } from "./api/client-types-chat";
import {
  CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
  CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY,
  claimCapabilityConnectorContinuation,
  consumeCapabilityConnectorContinuation,
  consumeCapabilityWorkspaceHandoff,
  findCapabilityWorkspaceHandoff,
  persistCapabilityConnectorContinuation,
  persistCapabilityWorkspaceHandoff,
} from "./capability-workspace-handoff";

function result(
  overrides: Partial<ChatActionResultSummary> = {},
): ChatActionResultSummary {
  return {
    actionName: "DEDICATED_CAPABILITY_REQUIRED",
    success: false,
    values: {
      capabilityHandoff: {
        version: 1,
        kind: "capability_handoff",
        capabilityId: "calendar",
        label: "Calendar",
        availability: "needs_workspace",
        reason: "Calendar needs your personal workspace.",
        currentTier: "shared",
        requiredTier: "personal",
        nextAction: "upgrade_workspace",
        requiresConfirmation: false,
        cta: {
          label: "Set up personal workspace",
          href: "/cloud/agents/agent-1",
        },
      },
    },
    ...overrides,
  };
}

describe("findCapabilityWorkspaceHandoff", () => {
  afterEach(() => window.sessionStorage.clear());
  it("preserves the submitted intent when the server omitted continuation", () => {
    const handoff = findCapabilityWorkspaceHandoff(
      [
        result({
          values: {
            capabilityHandoff: {
              ...(result().values?.capabilityHandoff as object),
              requiresConfirmation: true,
            },
          },
        }),
      ],
      "Move tomorrow's meeting to 3pm",
    );

    expect(handoff).toMatchObject({
      capabilityId: "calendar",
      cta: { href: "/cloud/agents/agent-1" },
      continuation: { originalIntent: "Move tomorrow's meeting to 3pm" },
    });
  });

  it("prefers server continuation metadata and rejects unsafe setup links", () => {
    const withContinuation = result();
    const values = withContinuation.values as Record<string, unknown>;
    const payload = values.capabilityHandoff as Record<string, unknown>;
    payload.continuation = {
      originalIntent: "Server intent",
      clientMessageId: "client-1",
    };
    expect(
      findCapabilityWorkspaceHandoff([withContinuation], "Fallback intent")
        ?.continuation,
    ).toEqual({
      originalIntent: "Server intent",
      clientMessageId: "client-1",
    });

    payload.cta = { label: "Continue", href: "https://evil.example/setup" };
    expect(findCapabilityWorkspaceHandoff([withContinuation])).toBeNull();
  });

  it("accepts the planner's successful setup action", () => {
    expect(
      findCapabilityWorkspaceHandoff([
        result({ actionName: "ENABLE_CAPABILITY", success: true }),
      ]),
    ).toMatchObject({ capabilityId: "calendar" });
  });

  it("ignores success/failure combinations that cannot create a handoff", () => {
    expect(
      findCapabilityWorkspaceHandoff([result({ success: true })]),
    ).toBeNull();
    expect(
      findCapabilityWorkspaceHandoff([
        result({ actionName: "ENABLE_CAPABILITY", success: false }),
      ]),
    ).toBeNull();
    expect(
      findCapabilityWorkspaceHandoff([result({ actionName: "OTHER" })]),
    ).toBeNull();
  });

  it("rejects unknown capabilities and oversized continuation metadata", () => {
    const invalidCapability = result();
    const invalidPayload = invalidCapability.values
      ?.capabilityHandoff as Record<string, unknown>;
    invalidPayload.capabilityId = "admin-shell";
    expect(findCapabilityWorkspaceHandoff([invalidCapability])).toBeNull();

    const oversized = result();
    const oversizedPayload = oversized.values?.capabilityHandoff as Record<
      string,
      unknown
    >;
    oversizedPayload.continuation = {
      originalIntent: "x".repeat(4_001),
      clientMessageId: "y".repeat(129),
    };
    expect(
      findCapabilityWorkspaceHandoff([oversized])?.continuation,
    ).toBeUndefined();
  });

  it("consumes a preserved intent only for its completed workspace", () => {
    const handoff = findCapabilityWorkspaceHandoff(
      [result()],
      "Move my meeting",
    );
    expect(handoff).not.toBeNull();
    if (!handoff) throw new Error("Expected a valid capability handoff");
    persistCapabilityWorkspaceHandoff(handoff);

    expect(consumeCapabilityWorkspaceHandoff("agent-2")).toBeNull();
    expect(
      window.sessionStorage.getItem(CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY),
    ).not.toBeNull();
    expect(consumeCapabilityWorkspaceHandoff("agent-1")).toMatchObject({
      continuation: { originalIntent: "Move my meeting" },
    });
    expect(
      window.sessionStorage.getItem(CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY),
    ).toBeNull();
  });

  it("drops stale continuation text instead of retaining it indefinitely", () => {
    const handoff = findCapabilityWorkspaceHandoff(
      [result()],
      "Email the report",
    );
    expect(handoff).not.toBeNull();
    if (!handoff) throw new Error("Expected a valid capability handoff");
    persistCapabilityWorkspaceHandoff(handoff, () => 1_000);

    expect(
      consumeCapabilityWorkspaceHandoff("agent-1", () => 31 * 60 * 1_000),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY),
    ).toBeNull();
  });

  it("binds and consumes typed intent only for the connector the user starts", () => {
    const handoff = findCapabilityWorkspaceHandoff(
      [
        result({
          values: {
            capabilityHandoff: {
              ...(result().values?.capabilityHandoff as object),
              requiresConfirmation: true,
            },
          },
        }),
      ],
      "Move tomorrow's meeting to 3pm",
    );
    if (!handoff) throw new Error("Expected a valid capability handoff");
    expect(
      persistCapabilityConnectorContinuation(handoff, "agent-1", () => 1_000),
    ).toBe(true);
    expect(
      claimCapabilityConnectorContinuation(
        "google-calendar",
        "agent-1",
        () => 2_000,
      ),
    ).toBe(true);

    expect(
      consumeCapabilityConnectorContinuation("gmail", "agent-1", () => 3_000),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(
        CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
      ),
    ).not.toBeNull();
    expect(
      consumeCapabilityConnectorContinuation(
        "google-calendar",
        "agent-1",
        () => 3_000,
      ),
    ).toMatchObject({
      agentId: "agent-1",
      capabilityId: "calendar",
      originalIntent: "Move tomorrow's meeting to 3pm",
      connectorId: "google-calendar",
    });
    expect(
      window.sessionStorage.getItem(
        CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
      ),
    ).toBeNull();
  });

  it("retains a connector continuation when the active agent does not match", () => {
    const handoff = findCapabilityWorkspaceHandoff(
      [
        result({
          values: {
            capabilityHandoff: {
              ...(result().values?.capabilityHandoff as object),
              requiresConfirmation: true,
            },
          },
        }),
      ],
      "Move tomorrow's meeting to 3pm",
    );
    if (!handoff) throw new Error("Expected a valid capability handoff");
    expect(persistCapabilityConnectorContinuation(handoff, "agent-1")).toBe(
      true,
    );
    expect(
      claimCapabilityConnectorContinuation("google-calendar", "agent-2"),
    ).toBe(false);
    expect(
      claimCapabilityConnectorContinuation("google-calendar", "agent-1"),
    ).toBe(true);
    expect(
      consumeCapabilityConnectorContinuation("google-calendar", "agent-2"),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(
        CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
      ),
    ).not.toBeNull();
  });

  it("does not carry non-connection capabilities into arbitrary setup", () => {
    const handoff = findCapabilityWorkspaceHandoff(
      [
        result({
          values: {
            capabilityHandoff: {
              ...(result().values?.capabilityHandoff as object),
              capabilityId: "filesystem",
            },
          },
        }),
      ],
      "Edit this file",
    );
    if (!handoff) throw new Error("Expected a valid capability handoff");
    expect(persistCapabilityConnectorContinuation(handoff, "agent-1")).toBe(
      false,
    );
    expect(claimCapabilityConnectorContinuation("gmail", "agent-1")).toBe(
      false,
    );
  });
});
