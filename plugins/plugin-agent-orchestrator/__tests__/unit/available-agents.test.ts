import { describe, expect, it } from "vitest";
import { availableAgentsProvider } from "../../src/providers/available-agents.js";
import {
  memory,
  runtimeWith,
  serviceMock,
  session,
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

  it("caps rendered sessions while keeping all structured session data", async () => {
    const sessions = Array.from({ length: 12 }, (_, index) =>
      session({
        id: `session-${String(index).padStart(2, "0")}`,
        status: index < 3 ? "ready" : "completed",
        lastActivityAt: new Date(
          Date.parse("2026-05-03T10:00:00.000Z") + index * 1000,
        ),
        metadata: { label: `demo-${index}` },
      }),
    );
    const result = await availableAgentsProvider.get(
      runtimeWith(serviceMock({ listSessions: () => sessions })),
      memory(),
      state,
    );

    expect(result.data?.activeSessions).toHaveLength(12);
    expect(result.text).toContain("Active sessions (12)");
    expect(result.text).toContain("... (+4 older sessions omitted)");
    expect(result.text?.match(/- demo-/g)).toHaveLength(8);
    expect(result.text).toContain("demo-2");
    expect(result.text).toContain("demo-0");
    expect(result.text).not.toContain("demo-3");
  });
});
