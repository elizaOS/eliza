/**
 * Verifies renderChangeSetBody.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { renderChangeSetBody } from "../../src/services/completion-evidence.js";

// #9146 — completion evidence renders the captured git changeset into the body
// a reviewer reads. Pin the rendering (file list, counts, diff section gating,
// truncation marker) so evidence stays human-verifiable.
const cs = (o: Record<string, unknown>) =>
  o as unknown as Parameters<typeof renderChangeSetBody>[0];

describe("renderChangeSetBody", () => {
  it("renders diffstat, file count + list, and the diff section", () => {
    const out = renderChangeSetBody(
      cs({
        changedFiles: ["a.ts", "b.ts"],
        diffStat: "2 files changed",
        diff: "+foo",
        truncated: false,
      }),
    );
    expect(out).toBe(
      [
        "diffstat: 2 files changed",
        "changedFiles (2): a.ts, b.ts",
        "diff:",
        "+foo",
      ].join("\n"),
    );
  });

  it("uses (none) placeholders for an empty changeset and omits the diff section", () => {
    const out = renderChangeSetBody(
      cs({ changedFiles: [], diffStat: "", diff: "", truncated: false }),
    );
    expect(out).toBe(
      ["diffstat: (none)", "changedFiles (0): (none)"].join("\n"),
    );
  });

  it("omits the diff section for a whitespace-only diff", () => {
    const out = renderChangeSetBody(
      cs({
        changedFiles: ["a.ts"],
        diffStat: "1",
        diff: "   \n  ",
        truncated: false,
      }),
    );
    expect(out).not.toContain("diff:");
  });

  it("appends a truncation marker when the changeset was truncated", () => {
    const out = renderChangeSetBody(
      cs({
        changedFiles: ["a.ts"],
        diffStat: "1",
        diff: "+x",
        truncated: true,
      }),
    );
    expect(out.endsWith("(changeset truncated)")).toBe(true);
  });
});
