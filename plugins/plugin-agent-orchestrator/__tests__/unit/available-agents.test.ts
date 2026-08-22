/**
 * Verifies availableAgentsProvider.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";

import {
  memory,
  runtimeWith,
  serviceMock,
  session,
  state,
} from "../../src/test-utils/action-test-utils.js";

const { availableAgentsProvider } = await import(
  "../../src/providers/available-agents.js"
);

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

  it("renders every session while keeping all structured session data", async () => {
    // Develop's #24134/#24232 (preserve complete model context) removed the
    // MAX_RENDERED_ACTIVE_SESSIONS cap: the model view lists every session,
    // active-first then most-recent-first, with no hidden omission.
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
    expect(result.text).not.toContain("older sessions omitted");
    const rendered = [...(result.text ?? "").matchAll(/- (demo-\d+) \[/g)].map(
      (match) => match[1],
    );
    expect(rendered).toEqual([
      "demo-2",
      "demo-1",
      "demo-0",
      "demo-11",
      "demo-10",
      "demo-9",
      "demo-8",
      "demo-7",
      "demo-6",
      "demo-5",
      "demo-4",
      "demo-3",
    ]);
  });
});
