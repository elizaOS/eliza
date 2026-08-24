/**
 * Public-surface and behavior coverage for the agent security barrel
 * (`security/index.ts`). The barrel must re-export every runtime symbol of
 * access.ts and audit-log.ts with preserved identity — a dropped or ambiguous
 * `export *` binding would silently break every plugin-facing import through
 * `@elizaos/agent/security` — and the authorization wrappers reachable
 * through it must keep their documented decisions: fail-closed denial for
 * unresolvable senders, the lenient local path when no sender context exists,
 * the #14707 fold of sourceless legacy OWNER grants, and J4 reporting on a
 * broken world-resolution pipeline. Real modules are driven end to end;
 * collaborators are minimal typed runtimes following access.test.ts.
 */

import type {
  IAgentRuntime,
  Memory,
  Role,
  Room,
  UUID,
  World,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as accessModule from "./access.ts";
import * as auditLogModule from "./audit-log.ts";
import * as securityIndex from "./index.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;
const OTHER_ENTITY_ID = "00000000-0000-0000-0000-0000000000ee" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000ff" as UUID;

function noReports(): void {}

function runtimeWith(
  reportError: () => void,
  overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    reportError,
    ...overrides,
  } as unknown as IAgentRuntime;
}

function message(entityId: UUID = ENTITY_ID): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000cc" as UUID,
    entityId,
    roomId: ROOM_ID,
    content: { text: "x" },
  } as Memory;
}

function dmRoom(): Room {
  return {
    id: ROOM_ID,
    agentId: AGENT_ID,
    source: "test",
    type: "DM",
    worldId: WORLD_ID,
  };
}

function groupRoomWithoutWorld(): Room {
  return {
    id: ROOM_ID,
    agentId: AGENT_ID,
    source: "test",
    type: "GROUP",
  };
}

function worldWithRoles(
  roles: Record<string, Role>,
  roleSources?: Record<string, string>,
): World {
  return {
    id: WORLD_ID,
    agentId: AGENT_ID,
    name: "world",
    metadata: { roles, ...(roleSources ? { roleSources } : {}) },
  };
}

describe("security barrel public surface", () => {
  it("re-exports every runtime export of access.ts with preserved identity", () => {
    expect(Object.keys(accessModule).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(accessModule)) {
      expect(securityIndex).toHaveProperty(name);
      expect(
        (securityIndex as unknown as Record<string, unknown>)[name],
        `barrel export ${name} must be the same binding`,
      ).toBe(value);
    }
  });

  it("re-exports every runtime export of audit-log.ts with preserved identity", () => {
    expect(Object.keys(auditLogModule).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(auditLogModule)) {
      expect(securityIndex).toHaveProperty(name);
      expect(
        (securityIndex as unknown as Record<string, unknown>)[name],
        `barrel export ${name} must be the same binding`,
      ).toBe(value);
    }
  });

  it("keeps the SandboxAuditLog class identity across import paths", () => {
    const log = new securityIndex.SandboxAuditLog({ console: false });
    expect(log).toBeInstanceOf(auditLogModule.SandboxAuditLog);
  });

  it("exposes the audit taxonomy constants", () => {
    expect(securityIndex.AUDIT_SEVERITIES).toEqual([
      "info",
      "warn",
      "error",
      "critical",
    ]);
    for (const eventType of [
      "policy_decision",
      "security_kill_switch",
      "sandbox_lifecycle",
    ] as const) {
      expect(securityIndex.AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });
});

describe("isAgentSelf through the barrel", () => {
  it("detects the agent's own entity", () => {
    expect(
      securityIndex.isAgentSelf(runtimeWith(noReports), message(AGENT_ID)),
    ).toBe(true);
  });

  it("rejects another entity", () => {
    expect(securityIndex.isAgentSelf(runtimeWith(noReports), message())).toBe(
      false,
    );
  });

  it("fails closed without a runtime", () => {
    expect(securityIndex.isAgentSelf(undefined, message())).toBe(false);
  });

  it("fails closed on an empty sender entityId", () => {
    expect(
      securityIndex.isAgentSelf(runtimeWith(noReports), message("" as UUID)),
    ).toBe(false);
  });
});

describe("role-gated access through the barrel", () => {
  it("grants OWNER to an explicit manual owner grant", async () => {
    const granted = await securityIndex.hasOwnerAccess(
      runtimeWith(noReports, {
        getRoom: async () => dmRoom(),
        getWorld: async () =>
          worldWithRoles({ [ENTITY_ID]: "OWNER" }, { [ENTITY_ID]: "manual" }),
      }),
      message(),
    );
    expect(granted).toBe(true);
  });

  it("folds a sourceless legacy OWNER grant to GUEST (#14707)", async () => {
    const granted = await securityIndex.hasOwnerAccess(
      runtimeWith(noReports, {
        getRoom: async () => dmRoom(),
        getWorld: async () => worldWithRoles({ [ENTITY_ID]: "OWNER" }),
      }),
      message(),
    );
    expect(granted).toBe(false);
  });

  it("grants ADMIN to an explicitly granted admin", async () => {
    const granted = await securityIndex.hasAdminAccess(
      runtimeWith(noReports, {
        getRoom: async () => dmRoom(),
        getWorld: async () => worldWithRoles({ [ENTITY_ID]: "ADMIN" }),
      }),
      message(),
    );
    expect(granted).toBe(true);
  });

  it("denies ADMIN to an unranked sender inside a resolved world", async () => {
    const reportError = vi.fn();
    const granted = await securityIndex.hasAdminAccess(
      runtimeWith(reportError, {
        getRoom: async () => dmRoom(),
        getWorld: async () => worldWithRoles({ [OTHER_ENTITY_ID]: "ADMIN" }),
      }),
      message(),
    );
    expect(granted).toBe(false);
    // A clean rank denial is not a broken pipeline: nothing is reported.
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("private-channel access through the barrel", () => {
  it("grants an explicitly granted member of a private world", async () => {
    const reportError = vi.fn();
    const granted = await securityIndex.hasPrivateAccess(
      runtimeWith(reportError, {
        getRoom: async () => dmRoom(),
        getWorld: async () => worldWithRoles({ [ENTITY_ID]: "MEMBER" }),
      }),
      message(),
    );
    expect(granted).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("denies when the message resolves to no world", async () => {
    const reportError = vi.fn();
    const granted = await securityIndex.hasPrivateAccess(
      runtimeWith(reportError, {
        getRoom: async () => groupRoomWithoutWorld(),
      }),
      message(),
    );
    expect(granted).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("denies an unlisted sender inside a resolved world", async () => {
    const reportError = vi.fn();
    const granted = await securityIndex.hasPrivateAccess(
      runtimeWith(reportError, {
        getRoom: async () => dmRoom(),
        getWorld: async () => worldWithRoles({ [OTHER_ENTITY_ID]: "ADMIN" }),
      }),
      message(),
    );
    expect(granted).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("stays fail-closed and reports when world resolution throws", async () => {
    const boom = new Error("world store unavailable");
    const reportError = vi.fn();
    const granted = await securityIndex.hasPrivateAccess(
      runtimeWith(reportError, {
        getRoom: async () => dmRoom(),
        getWorld: async () => {
          throw boom;
        },
      }),
      message(),
    );
    expect(granted).toBe(false);
    // error-policy:J4 — deny AND surface via the wrapper's own scope.
    expect(reportError).toHaveBeenCalledWith("Access.hasPrivateAccess", boom, {
      entityId: ENTITY_ID,
    });
  });
});

describe("process-wide audit feed wiring through the barrel", () => {
  beforeEach(() => {
    securityIndex.__resetAuditFeedForTests();
  });

  it("publishes SandboxAuditLog records into the shared feed", () => {
    const log = new securityIndex.SandboxAuditLog({ console: false });
    log.record({ type: "policy_decision", summary: "s1", severity: "info" });
    log.record({ type: "fetch_proxy_error", summary: "s2", severity: "error" });
    expect(securityIndex.getAuditFeedSize()).toBe(2);
    const policyEntries = securityIndex.queryAuditFeed({
      type: "policy_decision",
    });
    expect(policyEntries).toHaveLength(1);
    expect(policyEntries[0].summary).toBe("s1");
  });

  it("notifies subscribers until they unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = securityIndex.subscribeAuditFeed(handler);
    const log = new securityIndex.SandboxAuditLog({ console: false });
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    log.record({ type: "sandbox_lifecycle", summary: "b", severity: "info" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reset isolates process-wide feed state between specs", () => {
    const log = new securityIndex.SandboxAuditLog({ console: false });
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    expect(securityIndex.getAuditFeedSize()).toBe(1);
    securityIndex.__resetAuditFeedForTests();
    expect(securityIndex.getAuditFeedSize()).toBe(0);
    expect(securityIndex.queryAuditFeed()).toEqual([]);
  });
});
