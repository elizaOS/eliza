// Exercises headscale integration behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import type { HeadscaleClient } from "./headscale-client";
import {
  DEFAULT_REGISTRATION_TIMEOUT_MS,
  HeadscaleIntegration,
  inferHeadscaleUser,
  inferTailscaleHostname,
  normalizeHeadscaleSegment,
} from "./headscale-integration";

const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("Headscale identity inference", () => {
  test("uses organization id before mutable agent identity", () => {
    expect(
      inferHeadscaleUser({
        agentName: "Mutable Agent",
        organizationId: "20afac01-a7d2-4643-9310-b79d63de5b25",
        userId: "user-123",
      }),
    ).toBe("org-20afac01-a7d2-4643-9310-b79d63de5b25");
  });

  test("falls back to user id, agent name, then configured default user", () => {
    process.env.HEADSCALE_USER = "agent";

    expect(inferHeadscaleUser({ userId: "usr_ABC" })).toBe("user-usr-abc");
    expect(inferHeadscaleUser({ agentName: "My Agent" })).toBe("agent-my-agent");
    expect(inferHeadscaleUser({})).toBe("agent");
  });

  test("keeps agent name only in the hostname and includes an id prefix", () => {
    expect(
      inferTailscaleHostname({
        agentName: "My Agent",
        agentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe("my-agent-11111111-111");
  });

  test("hostname stays within the 63-char DNS label limit", () => {
    // A node name that exceeds 63 chars is rejected by DNS / Tailscale; the
    // slice(0, 63) must keep us under the limit even with long inputs.
    // base(60) + "-" + suffix(12) = 73 chars pre-slice, so this genuinely
    // exercises the slice(0, 63) cap (not just a 63-char boundary).
    const hostname = inferTailscaleHostname({
      agentName: "a".repeat(60),
      agentId: "b".repeat(50),
    });
    expect(hostname.length).toBeLessThanOrEqual(63);
  });

  test("hostname never ends with a hyphen even when the 63-char slice cuts one", () => {
    // base(62) + "-" + suffix puts the slice boundary on the hyphen; the
    // trailing-hyphen strip must run AFTER the slice.
    const hostname = inferTailscaleHostname({ agentName: "a".repeat(62), agentId: "x" });
    expect(hostname).not.toMatch(/-$/);
    expect(hostname).toBe("a".repeat(62));
  });

  test("hostname normalizes special chars to a valid DNS label and never empties", () => {
    expect(inferTailscaleHostname({ agentName: "Test@Agent!", agentId: "UUID-1234-5678" })).toBe(
      "test-agent-uuid-1234-56",
    );
    expect(inferTailscaleHostname({ agentName: "", agentId: "" })).toBe("agent-agent");
  });

  test("inferHeadscaleUser reads HEADSCALE_USER for the all-empty fallback", () => {
    // Proves the env fallback is actually consulted (not hardcoded to "agent").
    process.env.HEADSCALE_USER = "custom-fallback";
    expect(inferHeadscaleUser({})).toBe("custom-fallback");
  });
});

describe("Headscale container credentials", () => {
  test("uses a persistent node with a single-use key so Docker restarts can reconnect", async () => {
    let request: Record<string, unknown> | null = null;
    const fake = {
      getNodeByNameStrict: async () => null,
      createPreAuthKey: async (input: Record<string, unknown>) => {
        request = input;
        return { key: "test-preauth-key" };
      },
    } as unknown as HeadscaleClient;

    const prepared = await new HeadscaleIntegration(fake).prepareContainerVPN({
      agentId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
    });

    expect(request).toMatchObject({
      reusable: false,
      ephemeral: false,
      aclTags: ["tag:agent"],
    });
    expect(prepared.preAuthKey).toBe("test-preauth-key");
  });

  test("removes a stale persistent registration before issuing a replacement key", async () => {
    const calls: string[] = [];
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        calls.push(`lookup:${name}`);
        return { id: "stale-node-70", name, ipAddresses: ["100.64.0.56"] };
      },
      deleteNode: async (id: string) => {
        calls.push(`delete:${id}`);
      },
      createPreAuthKey: async () => {
        calls.push("create-key");
        return { key: "replacement-key" };
      },
    } as unknown as HeadscaleClient;

    await new HeadscaleIntegration(fake).prepareContainerVPN({
      agentId: "11111111-1111-4111-8111-111111111111",
      agentName: "Eliza",
    });

    expect(calls).toEqual(["lookup:eliza-11111111-111", "delete:stale-node-70", "create-key"]);
  });

  test("reclaimStaleNode=false records the live node instead of deleting it (#16565)", async () => {
    // Blue/green: the same-name node is the LIVE serving one — deleting it
    // pre-provision cuts the agent's mesh route mid-upgrade.
    const calls: string[] = [];
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        calls.push(`lookup:${name}`);
        return { id: "live-node-4", name, ipAddresses: ["100.64.0.56"] };
      },
      deleteNode: async (id: string) => {
        calls.push(`delete:${id}`);
      },
      createPreAuthKey: async () => {
        calls.push("create-key");
        return { key: "blue-key" };
      },
    } as unknown as HeadscaleClient;

    const prepared = await new HeadscaleIntegration(fake).prepareContainerVPN({
      agentId: "11111111-1111-4111-8111-111111111111",
      agentName: "Eliza",
      reclaimStaleNode: false,
    });

    expect(calls).toEqual(["lookup:eliza-11111111-111", "create-key"]);
    expect(prepared.previousNodeId).toBe("live-node-4");
  });
});

describe("Headscale node lookup is keyed on the node name (not the agentId)", () => {
  // Regression guard: the container registers under TS_HOSTNAME
  // (inferTailscaleHostname = `<agentName>-<id12>`), so lookups must use that
  // name. Polling/cleaning up by the bare agentId never matched the node — it
  // "timed out" registering and orphaned the node despite it being online.
  const nodeName = inferTailscaleHostname({
    agentName: "My Agent",
    agentId: "11111111-1111-4111-8111-111111111111",
  });

  test("waitForVPNRegistration polls getNodeByName with the node name", async () => {
    const lookups: string[] = [];
    const fake = {
      getNodeByName: async (name: string) => {
        lookups.push(name);
        return { id: "node-1", name, ipAddresses: ["100.64.0.7"] };
      },
    } as unknown as HeadscaleClient;

    const registration = await new HeadscaleIntegration(fake).waitForVPNRegistration(
      nodeName,
      1_000,
    );

    expect(registration?.ip).toBe("100.64.0.7");
    expect(registration?.nodeId).toBe("node-1");
    expect(lookups).toEqual([nodeName]);
    expect(nodeName).not.toBe("11111111-1111-4111-8111-111111111111");
  });

  test("cleanupContainerVPN deletes the node found by the node name", async () => {
    const lookups: string[] = [];
    let deletedId: string | null = null;
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        lookups.push(name);
        return { id: "node-9", name, ipAddresses: ["100.64.0.7"] };
      },
      deleteNode: async (id: string) => {
        deletedId = id;
      },
    } as unknown as HeadscaleClient;

    await new HeadscaleIntegration(fake).cleanupContainerVPN(nodeName);

    expect(lookups).toEqual([nodeName]);
    expect(deletedId).toBe("node-9");
  });

  test("waitForVPNRegistration skips the excluded live node until its replacement appears (#16565)", async () => {
    // During the blue/green overlap old + new nodes share the hostname; the
    // preserved live node's id must never satisfy the registration wait.
    let polls = 0;
    const fake = {
      getNodeByName: async (name: string) => {
        polls += 1;
        return polls < 3
          ? { id: "old-live-node", name, ipAddresses: ["100.64.0.7"] }
          : { id: "blue-node", name, ipAddresses: ["100.64.0.8"] };
      },
    } as unknown as HeadscaleClient;

    const registration = await new HeadscaleIntegration(fake).waitForVPNRegistration(
      nodeName,
      5_000,
      { excludeNodeId: "old-live-node" },
    );

    expect(registration?.nodeId).toBe("blue-node");
    expect(registration?.ip).toBe("100.64.0.8");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test("cleanupContainerVPN surfaces an API failure instead of reading it as nothing-to-clean-up (#16565)", async () => {
    // The lossy lookup swallowed API errors into null → "nothing to clean up"
    // → silently leaked persistent node. Strict lookup lands in the warn path;
    // still non-blocking for container deletion.
    let deleteCalled = false;
    const fake = {
      getNodeByNameStrict: async () => {
        throw new Error("headscale API 502");
      },
      deleteNode: async () => {
        deleteCalled = true;
      },
    } as unknown as HeadscaleClient;

    await expect(
      new HeadscaleIntegration(fake).cleanupContainerVPN(nodeName),
    ).resolves.toBeUndefined();
    expect(deleteCalled).toBe(false);
  });

  test("removeVpnNodeById deletes by id and never throws on failure (#16565)", async () => {
    const deleted: string[] = [];
    const ok = {
      deleteNode: async (id: string) => {
        deleted.push(id);
      },
    } as unknown as HeadscaleClient;
    await new HeadscaleIntegration(ok).removeVpnNodeById("node-42");
    expect(deleted).toEqual(["node-42"]);

    const failing = {
      deleteNode: async () => {
        throw new Error("headscale down");
      },
    } as unknown as HeadscaleClient;
    await expect(
      new HeadscaleIntegration(failing).removeVpnNodeById("node-43"),
    ).resolves.toBeUndefined();
  });
});

describe("normalizeHeadscaleSegment + registration-timeout default", () => {
  test("lowercases, trims, replaces invalid chars, collapses + strips hyphens", () => {
    expect(normalizeHeadscaleSegment("  HELLO  ")).toBe("hello");
    expect(normalizeHeadscaleSegment("hello@world!")).toBe("hello-world");
    expect(normalizeHeadscaleSegment("hello---world")).toBe("hello-world");
    expect(normalizeHeadscaleSegment("-hello-")).toBe("hello");
  });

  test("returns null for empty / whitespace-only / undefined", () => {
    expect(normalizeHeadscaleSegment("")).toBeNull();
    expect(normalizeHeadscaleSegment("   ")).toBeNull();
    expect(normalizeHeadscaleSegment(undefined)).toBeNull();
  });

  test("DEFAULT_REGISTRATION_TIMEOUT_MS falls back to 180s when env is unset", () => {
    expect(DEFAULT_REGISTRATION_TIMEOUT_MS).toBe(180_000);
  });
});
