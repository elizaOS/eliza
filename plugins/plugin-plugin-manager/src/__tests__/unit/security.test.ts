/**
 * Confirms the security helper wired into the PLUGIN action actually gates on
 * the elizaOS role hierarchy, rather than the previous "always allow" stub.
 *
 * Uses dependency injection (the `deps` argument) so we don't need to monkey-
 * patch `@elizaos/core`, which would contaminate other test files in the
 * same `bun test` run.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { hasAdminAccess, hasOwnerAccess, type SecurityDeps } from "../../security";

function fakeRuntime(agentId = "agent-1"): IAgentRuntime {
  return { agentId } as unknown as IAgentRuntime;
}

function fakeMessage(entityId: string): Memory {
  return { entityId } as unknown as Memory;
}

function depsFor(opts: {
  ownerId?: string | null;
  role?: { isOwner: boolean; isAdmin: boolean } | null;
  rolesThrows?: boolean;
}): SecurityDeps {
  return {
    resolveCanonicalOwnerIdForMessage: async () => opts.ownerId ?? null,
    checkSenderRole: async () => {
      if (opts.rolesThrows) throw new Error("role lookup boom");
      return opts.role ?? { isOwner: false, isAdmin: false };
    },
  };
}

describe("plugin-plugin-manager security gates", () => {
  it("allows when context is missing (auth handled at a higher layer)", async () => {
    expect(await hasOwnerAccess(undefined, undefined)).toBe(true);
    expect(await hasOwnerAccess(fakeRuntime(), undefined)).toBe(true);
    expect(await hasOwnerAccess(undefined, fakeMessage("u"))).toBe(true);
  });

  it("allows the agent itself", async () => {
    const result = await hasOwnerAccess(
      fakeRuntime("agent-1"),
      fakeMessage("agent-1"),
      depsFor({})
    );
    expect(result).toBe(true);
  });

  it("allows the canonical owner", async () => {
    const result = await hasOwnerAccess(
      fakeRuntime("agent-1"),
      fakeMessage("owner-99"),
      depsFor({ ownerId: "owner-99" })
    );
    expect(result).toBe(true);
  });

  it("rejects a non-owner sender", async () => {
    const result = await hasOwnerAccess(
      fakeRuntime("agent-1"),
      fakeMessage("random-user"),
      depsFor({ role: { isOwner: false, isAdmin: false } })
    );
    expect(result).toBe(false);
  });

  it("hasAdminAccess accepts admin-but-not-owner senders", async () => {
    const result = await hasAdminAccess(
      fakeRuntime("agent-1"),
      fakeMessage("admin-user"),
      depsFor({ role: { isOwner: false, isAdmin: true } })
    );
    expect(result).toBe(true);
  });

  it("hasOwnerAccess rejects admin-but-not-owner senders", async () => {
    const result = await hasOwnerAccess(
      fakeRuntime("agent-1"),
      fakeMessage("admin-user"),
      depsFor({ role: { isOwner: false, isAdmin: true } })
    );
    expect(result).toBe(false);
  });

  it("returns false when checkSenderRole throws", async () => {
    const result = await hasOwnerAccess(
      fakeRuntime("agent-1"),
      fakeMessage("random-user"),
      depsFor({ rolesThrows: true })
    );
    expect(result).toBe(false);
  });
});
