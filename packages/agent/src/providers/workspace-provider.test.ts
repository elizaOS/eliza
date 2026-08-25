/** Verifies workspace routing and complete init-file prompt rendering. */
import { describe, expect, it } from "vitest";
import { buildContext, createWorkspaceProvider } from "./workspace-provider.ts";

describe("workspace provider routing", () => {
  it("only enters planner contexts that can act on the workspace", () => {
    const provider = createWorkspaceProvider();
    expect(provider.contexts).toEqual([
      "code",
      "files",
      "terminal",
      "automation",
    ]);
    expect(provider.contextGate).toEqual({
      anyOf: ["code", "files", "terminal", "automation"],
    });
  });
});

describe("workspace provider prompt rendering", () => {
  it("preserves every file beyond the former per-file and aggregate caps", () => {
    const first = `FIRST_HEAD${"a".repeat(120_000)}FIRST_TAIL`;
    const second = `SECOND_HEAD${"b".repeat(120_000)}SECOND_TAIL`;
    const rendered = buildContext([
      {
        name: "AGENTS.md",
        path: "/repo/AGENTS.md",
        content: first,
        missing: false,
      },
      {
        name: "TOOLS.md",
        path: "/repo/TOOLS.md",
        content: second,
        missing: false,
      },
    ]);
    expect(rendered).toContain(first);
    expect(rendered).toContain(second);
    expect(rendered).not.toMatch(/truncated|omitted/i);
  });
});
