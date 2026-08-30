// Exercises headscale integration behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { HeadscaleClient } from "./headscale-client";
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
  test("uses a persistent node with a REUSABLE key so a de-authorizing reboot can re-register", async () => {
    // Reusable (was single-use): a hard reset de-authorizes the persisted node
    // identity, forcing a fresh `tailscale up --authkey`. A single-use key
    // returns `authkey already used` on that second boot and the container
    // crash-loops (the prod-2 outage). Reusable + tag:agent + ACL isolation
    // lets the same agent re-register on the same baked key.
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
      reusable: true,
      ephemeral: false,
      aclTags: ["tag:agent"],
    });
    expect(request).not.toHaveProperty("user");
    expect(request).not.toHaveProperty("ensureUser");
    expect(prepared.preAuthKey).toBe("test-preauth-key");
  });

  test("removes a stale persistent registration before issuing a replacement key", async () => {
    const calls: string[] = [];
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        calls.push(`lookup:${name}`);
        return { id: "70", name, ipAddresses: ["100.64.0.56"] };
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

    expect(calls).toEqual(["lookup:eliza-11111111-111", "delete:70", "create-key"]);
  });

  test("reclaimStaleNode=false records the live node instead of deleting it (#16565)", async () => {
    // Blue/green: the same-name node is the LIVE serving one — deleting it
    // pre-provision cuts the agent's mesh route mid-upgrade.
    const calls: string[] = [];
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        calls.push(`lookup:${name}`);
        return { id: "4", name, ipAddresses: ["100.64.0.56"] };
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
    expect(prepared.previousNodeId).toBe("4");
  });

  test("exact preparation proves a stale 1404 node absent before minting a key", async () => {
    const calls: string[] = [];
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        calls.push(`lookup:${name}`);
        return { id: "1404", name, ipAddresses: ["100.64.0.56"] };
      },
      deleteNode: async (id: string) => {
        calls.push(`delete:${id}`);
      },
      listNodesStrict: async () => {
        calls.push("list");
        return [];
      },
      createPreAuthKey: async () => {
        calls.push("create-key");
        return { key: "replacement-key" };
      },
    } as unknown as HeadscaleClient;

    await expect(
      new HeadscaleIntegration(fake).prepareContainerVPN({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Eliza",
        requireExactNodeRetirement: true,
      }),
    ).resolves.toMatchObject({ preAuthKey: "replacement-key" });
    expect(calls).toEqual(["lookup:eliza-11111111-111", "delete:1404", "list", "create-key"]);
  });

  test("exact preparation rejects a swallowed deletion even when the node was concurrently renamed", async () => {
    let createKeyCalled = false;
    const fake = {
      getNodeByNameStrict: async (name: string) => ({
        id: "1404",
        name,
        ipAddresses: ["100.64.0.56"],
      }),
      // Models the current client bug where a 500 message containing route id
      // 1404 is misclassified as an already-gone 404.
      deleteNode: async () => {},
      listNodesStrict: async () => [
        {
          id: "1404",
          name: "renamed-after-delete",
          ipAddresses: ["100.64.0.56"],
        },
      ],
      createPreAuthKey: async () => {
        createKeyCalled = true;
        return { key: "must-not-be-created" };
      },
    } as unknown as HeadscaleClient;

    await expect(
      new HeadscaleIntegration(fake).prepareContainerVPN({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Eliza",
        requireExactNodeRetirement: true,
      }),
    ).rejects.toThrow("cannot prove stale Headscale node 1404 retired");
    expect(createKeyCalled).toBe(false);
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

  test("waitForVPNRegistration polls the collision-tolerant lookup with the node name", async () => {
    const lookups: string[] = [];
    const fake = {
      getNodeByNameOrSuffixed: async (name: string) => {
        lookups.push(name);
        return { id: "1", name, ipAddresses: ["100.64.0.7"] };
      },
    } as unknown as HeadscaleClient;

    const registration = await new HeadscaleIntegration(fake).waitForVPNRegistration(
      nodeName,
      1_000,
    );

    expect(registration?.ip).toBe("100.64.0.7");
    expect(registration?.nodeId).toBe("1");
    expect(registration?.rename).toEqual({ outcome: "not-needed" });
    expect(lookups).toEqual([nodeName]);
    expect(nodeName).not.toBe("11111111-1111-4111-8111-111111111111");
  });

  test("waitForVPNRegistration aborts immediately on a proven terminal candidate", async () => {
    let lookups = 0;
    let probes = 0;
    const fake = {
      getNodeByNameOrSuffixed: async () => {
        lookups += 1;
        return null;
      },
    } as unknown as HeadscaleClient;

    await expect(
      new HeadscaleIntegration(fake).waitForVPNRegistration(nodeName, 5_000, {
        probeTerminalCandidateFailure: async () => {
          probes += 1;
          return new Error("candidate requires interactive Headscale authorization");
        },
      }),
    ).rejects.toThrow("candidate requires interactive Headscale authorization");
    expect(lookups).toBe(1);
    expect(probes).toBe(1);
  });

  test("waitForVPNRegistration preserves the normal budget while the candidate is pending", async () => {
    let probes = 0;
    const fake = {
      getNodeByNameOrSuffixed: async () => null,
    } as unknown as HeadscaleClient;

    await expect(
      new HeadscaleIntegration(fake).waitForVPNRegistration(nodeName, 25, {
        probeTerminalCandidateFailure: async () => {
          probes += 1;
          return null;
        },
      }),
    ).resolves.toBeNull();
    expect(probes).toBeGreaterThanOrEqual(1);
  });

  test("waitForVPNRegistration returns a routed IP before consulting the terminal probe", async () => {
    let probes = 0;
    const fake = {
      getNodeByNameOrSuffixed: async (name: string) => ({
        id: "73",
        name,
        ipAddresses: ["100.64.0.73"],
      }),
    } as unknown as HeadscaleClient;

    await expect(
      new HeadscaleIntegration(fake).waitForVPNRegistration(nodeName, 1_000, {
        probeTerminalCandidateFailure: async () => {
          probes += 1;
          return new Error("must not override a successful registration");
        },
      }),
    ).resolves.toMatchObject({ ip: "100.64.0.73", nodeId: "73" });
    expect(probes).toBe(0);
  });

  test("waitForVPNRegistration rejects malformed runtime node identity", async () => {
    for (const malformedNode of [
      { id: "", name: nodeName, ipAddresses: ["100.64.0.7"] },
      { id: "01", name: nodeName, ipAddresses: ["100.64.0.7"] },
      { id: "18446744073709551616", name: nodeName, ipAddresses: ["100.64.0.7"] },
      { id: "1", name: nodeName, ipAddresses: ["   "] },
      { id: "1", name: nodeName, ipAddresses: ["256.64.0.7"] },
      { id: "1", name: nodeName, ipAddresses: ["127.0.0.1"] },
      { id: "1", name: nodeName, ipAddresses: ["8.8.8.8"] },
      { id: "1", name: nodeName, ipAddresses: ["1.64.0.7"] },
      { id: "1", name: nodeName, ipAddresses: ["192.100.0.7"] },
      { id: "1", name: nodeName, ipAddresses: ["100.128.0.7"] },
      { id: "1", name: nodeName, ipAddresses: [42] },
    ]) {
      const fake = {
        getNodeByNameOrSuffixed: async () => malformedNode,
      } as unknown as HeadscaleClient;

      await expect(
        new HeadscaleIntegration(fake).waitForVPNRegistration(nodeName, 25),
      ).resolves.toBeNull();
    }
  });

  test("cleanupContainerVPN deletes the node found by the node name", async () => {
    const lookups: string[] = [];
    let deletedId: string | null = null;
    const fake = {
      getNodeByNameStrict: async (name: string) => {
        lookups.push(name);
        return { id: "9", name, ipAddresses: ["100.64.0.7"] };
      },
      deleteNode: async (id: string) => {
        deletedId = id;
      },
    } as unknown as HeadscaleClient;

    await new HeadscaleIntegration(fake).cleanupContainerVPN(nodeName);

    expect(lookups).toEqual([nodeName]);
    expect(deletedId).toBe("9");
  });

  test("waitForVPNRegistration skips the excluded live node until its replacement appears (#16565)", async () => {
    // During the blue/green overlap old + new nodes share the hostname; the
    // preserved live node's id must never satisfy the registration wait —
    // even when the client lookup returns it (belt and braces on top of the
    // client-side exclusion).
    let polls = 0;
    const seenOptions: ({ excludeNodeId?: string; createdAfter?: Date } | undefined)[] = [];
    const fake = {
      getNodeByNameOrSuffixed: async (
        name: string,
        options?: { excludeNodeId?: string; createdAfter?: Date },
      ) => {
        polls += 1;
        seenOptions.push(options);
        return polls < 3
          ? { id: "41", name, ipAddresses: ["100.64.0.7"] }
          : { id: "42", name, ipAddresses: ["100.64.0.8"] };
      },
    } as unknown as HeadscaleClient;

    const registration = await new HeadscaleIntegration(fake).waitForVPNRegistration(
      nodeName,
      5_000,
      { excludeNodeId: "41" },
    );

    expect(registration?.nodeId).toBe("42");
    expect(registration?.ip).toBe("100.64.0.8");
    expect(registration?.rename).toEqual({ outcome: "not-needed" });
    expect(polls).toBeGreaterThanOrEqual(3);
    // The client lookup must receive the exclusion and the poll-start gate.
    expect(seenOptions[0]?.excludeNodeId).toBe("41");
    expect(seenOptions[0]?.createdAfter).toBeInstanceOf(Date);
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
    await new HeadscaleIntegration(ok).removeVpnNodeById("42");
    expect(deleted).toEqual(["42"]);

    const failing = {
      deleteNode: async () => {
        throw new Error("headscale down");
      },
    } as unknown as HeadscaleClient;
    await expect(
      new HeadscaleIntegration(failing).removeVpnNodeById("43"),
    ).resolves.toBeUndefined();
  });
});

describe("waitForVPNRegistration adopts Headscale collision-renamed nodes (real client, stubbed fetch)", () => {
  // Blue/green upgrade: the preserved green node holds the base hostname, so
  // Headscale renames the fresh blue registration to `<name>-<random8>`
  // (observed: eliza-00e6292c-e55-cnpx9uop). These tests drive the full
  // poll -> client -> HTTP path with only fetch stubbed.
  const baseName = "eliza-00e6292c-e55";
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const makeNode = (id: string, name: string, ip: string, createdAt: Date) => ({
    id,
    name,
    user: { name: "1" },
    ipAddresses: [ip],
    online: true,
    lastSeen: new Date().toISOString(),
    createdAt: createdAt.toISOString(),
  });

  /** Serves the node list for GET /api/v1/node and records/answers rename calls. */
  const stubHeadscale = (nodes: unknown[], opts?: { renameStatus?: number }) => {
    const renameUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rename/")) {
        renameUrls.push(url);
        const status = opts?.renameStatus ?? 200;
        return {
          ok: status < 400,
          status,
          statusText: status < 400 ? "OK" : "Internal Server Error",
          json: async () => ({}),
          text: async () => "{}",
          headers: new Headers({ "content-type": "application/json" }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ nodes }),
        text: async () => JSON.stringify({ nodes }),
        headers: new Headers({ "content-type": "application/json" }),
      } as Response;
    }) as typeof fetch;
    return renameUrls;
  };

  const integration = () =>
    new HeadscaleIntegration(
      new HeadscaleClient({ apiUrl: "https://headscale.example", apiKey: "secret", user: "1" }),
    );

  test("adopts the fresh suffixed blue node past the excluded green and renames it back", async () => {
    const renames = stubHeadscale([
      makeNode("3", baseName, "100.64.0.56", new Date(Date.now() - 60 * 60 * 1000)),
      makeNode("8", `${baseName}-cnpx9uop`, "100.64.0.8", new Date(Date.now() + 60_000)),
    ]);

    const registration = await integration().waitForVPNRegistration(baseName, 5_000, {
      excludeNodeId: "3",
    });

    expect(registration?.nodeId).toBe("8");
    expect(registration?.ip).toBe("100.64.0.8");
    expect(registration?.rename).toEqual({ outcome: "succeeded" });
    expect(renames).toEqual([`https://headscale.example/api/v1/node/8/rename/${baseName}`]);
  });

  test("a 5xx rename-back remains explicitly unresolved without losing adoption", async () => {
    // While the green node still holds the base name Headscale rejects the
    // rename; registration is already secured and must succeed regardless.
    const renames = stubHeadscale(
      [
        makeNode("3", baseName, "100.64.0.56", new Date(Date.now() - 60 * 60 * 1000)),
        makeNode("8", `${baseName}-cnpx9uop`, "100.64.0.8", new Date(Date.now() + 60_000)),
      ],
      { renameStatus: 500 },
    );

    const registration = await integration().waitForVPNRegistration(baseName, 5_000, {
      excludeNodeId: "3",
    });

    expect(registration?.nodeId).toBe("8");
    expect(registration?.ip).toBe("100.64.0.8");
    expect(registration?.rename.outcome).toBe("unresolved");
    if (registration?.rename.outcome === "unresolved") {
      expect(registration.rename.cause).toBeInstanceOf(Error);
      expect((registration.rename.cause as Error).message).toContain("500");
    }
    expect(renames.length).toBe(1);
  });

  test("only an observed HTTP 409 proves the expected rename conflict", async () => {
    const renames = stubHeadscale(
      [
        makeNode("3", baseName, "100.64.0.56", new Date(Date.now() - 60 * 60 * 1000)),
        makeNode("8", `${baseName}-cnpx9uop`, "100.64.0.8", new Date(Date.now() + 60_000)),
      ],
      { renameStatus: 409 },
    );

    const registration = await integration().waitForVPNRegistration(baseName, 5_000, {
      excludeNodeId: "3",
    });

    expect(registration?.rename.outcome).toBe("conflict-proven");
    expect(renames).toHaveLength(1);
  });

  test("a transport-like rename failure remains unresolved", async () => {
    const transportFailure = new Error("socket timed out after request write");
    const fake = {
      getNodeByNameOrSuffixed: async () => ({
        id: "8",
        name: `${baseName}-cnpx9uop`,
        ipAddresses: ["100.64.0.8"],
      }),
      renameNode: async () => {
        throw transportFailure;
      },
    } as unknown as HeadscaleClient;

    const registration = await new HeadscaleIntegration(fake).waitForVPNRegistration(
      baseName,
      5_000,
    );

    expect(registration?.rename).toEqual({
      outcome: "unresolved",
      cause: transportFailure,
    });
  });

  test("does not attempt a rename when the node registered under the exact name", async () => {
    const renames = stubHeadscale([makeNode("4", baseName, "100.64.0.9", new Date())]);

    const registration = await integration().waitForVPNRegistration(baseName, 5_000);

    expect(registration?.nodeId).toBe("4");
    expect(registration?.rename).toEqual({ outcome: "not-needed" });
    expect(renames).toEqual([]);
  });

  test("never adopts a suffixed node created before the poll started", async () => {
    // The previous cycle's green node (or an orphan from a failed upgrade)
    // keeps its suffixed name forever; adopting it would route the sandbox to
    // the wrong container. Stale suffixed nodes must time out instead.
    stubHeadscale([
      makeNode("5", `${baseName}-aaaaaaaa`, "100.64.0.5", new Date(Date.now() - 60 * 60 * 1000)),
    ]);

    const registration = await integration().waitForVPNRegistration(baseName, 300);

    expect(registration).toBeNull();
  });

  test("times out with null when no node matches at all", async () => {
    stubHeadscale([makeNode("2", "other-agent", "100.64.0.2", new Date())]);

    const registration = await integration().waitForVPNRegistration(baseName, 300);

    expect(registration).toBeNull();
  });

  test("times out when only the excluded green node exists", async () => {
    stubHeadscale([makeNode("3", baseName, "100.64.0.56", new Date())]);

    const registration = await integration().waitForVPNRegistration(baseName, 300, {
      excludeNodeId: "3",
    });

    expect(registration).toBeNull();
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
