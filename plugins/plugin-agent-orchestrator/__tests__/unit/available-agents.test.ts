import { describe, expect, it } from "vitest";
import { availableAgentsProvider } from "../../src/providers/available-agents.js";
import {
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("availableAgentsProvider", () => {
  it("returns service unavailable data", async () => {
    const result = await availableAgentsProvider.get(
      runtimeWith(undefined),
      memory(),
      state,
    );
    expect(result.data?.serviceAvailable).toBe(false);
    expect(result.data?.agents).toEqual([]);
  });
  it("returns available adapters and active sessions", async () => {
    const result = await availableAgentsProvider.get(
      runtimeWith(serviceMock()),
      memory(),
      state,
    );
    expect(result.data?.serviceAvailable).toBe(true);
    expect(result.data?.agents).toEqual([
      {
        adapter: "codex",
        agentType: "codex",
        installed: true,
        auth: { status: "unknown" },
      },
    ]);
    expect(result.data?.activeSessions).toEqual([
      {
        id: "abcdef123456",
        label: "demo",
        agentType: "codex",
        status: "ready",
        workdir: "/tmp/acp",
      },
    ]);
  });
});
