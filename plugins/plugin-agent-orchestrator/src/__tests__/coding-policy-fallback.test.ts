/**
 * Deterministically verifies ordered coding-backend readiness selection without
 * spawning a process; preflight results are supplied by a structural service.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveReadyCodingBackend } from "../actions/tasks.js";

afterEach(() => {
  delete process.env.ELIZA_CODING_FALLBACK_BACKENDS;
});

describe("resolveReadyCodingBackend", () => {
  it("selects the first ready route in configured order", async () => {
    process.env.ELIZA_CODING_FALLBACK_BACKENDS = "claude,opencode";
    const service = {
      checkAvailableAgents: async () => [
        {
          adapter: "codex",
          agentType: "codex",
          installed: false,
          auth: { status: "unknown" },
        },
        {
          adapter: "claude",
          agentType: "claude",
          installed: true,
          auth: { status: "authenticated" },
        },
        {
          adapter: "opencode",
          agentType: "opencode",
          installed: true,
          auth: { status: "authenticated" },
        },
      ],
    };

    await expect(
      resolveReadyCodingBackend(service as never, "codex"),
    ).resolves.toBe("claude");
  });

  it("fails before spawn when every selected/fallback route is unavailable", async () => {
    process.env.ELIZA_CODING_FALLBACK_BACKENDS = "claude";
    const service = {
      checkAvailableAgents: async () => [
        {
          adapter: "codex",
          agentType: "codex",
          installed: false,
          auth: { status: "unknown" },
        },
        {
          adapter: "claude",
          agentType: "claude",
          installed: true,
          auth: { status: "unauthenticated" },
        },
      ],
    };

    await expect(
      resolveReadyCodingBackend(service as never, "codex"),
    ).rejects.toMatchObject({ code: "CODING_POLICY_ROUTES_UNAVAILABLE" });
  });
});
