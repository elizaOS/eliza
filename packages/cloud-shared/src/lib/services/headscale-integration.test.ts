import { afterEach, describe, expect, test } from "bun:test";
import { inferHeadscaleUser, inferTailscaleHostname } from "./headscale-integration";

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
