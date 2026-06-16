import { afterEach, describe, expect, test } from "bun:test";
import {
  HeadscaleIntegration,
  inferHeadscaleUser,
  inferTailscaleHostname,
} from "./headscale-integration";
import type { HeadscaleClient } from "./headscale-client";

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

    const ip = await new HeadscaleIntegration(fake).waitForVPNRegistration(nodeName, 1_000);

    expect(ip).toBe("100.64.0.7");
    expect(lookups).toEqual([nodeName]);
    expect(nodeName).not.toBe("11111111-1111-4111-8111-111111111111");
  });

  test("cleanupContainerVPN deletes the node found by the node name", async () => {
    const lookups: string[] = [];
    let deletedId: string | null = null;
    const fake = {
      getNodeByName: async (name: string) => {
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
});
