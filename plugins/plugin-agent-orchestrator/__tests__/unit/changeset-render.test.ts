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

  it("renders a ~4KB single-file diff WHOLE — no renderer re-cut (tj-92080304431050 regression)", () => {
    // Live incident: a 3.9KB word-counter diff was re-cut at the renderer's
    // old 3_000 cap, mid-<script> ("const wordCountEl = document."), and the
    // judge fabricated "malformed HTML (missing closing brackets)". The
    // renderer allowance now sits above the capture cap, so anything capture
    // shipped whole stays whole.
    const script =
      "+        const wordCountEl = document.getElementById('wordCount');\n".repeat(
        60,
      );
    const diff = `diff --git a/index.html b/index.html\n${script}+    </script>\n+</body>\n+</html>`;
    expect(diff.length).toBeGreaterThan(3_000);
    const out = renderChangeSetBody(
      cs({
        changedFiles: ["index.html"],
        diffStat: "1 file changed",
        diff,
        truncated: false,
      }),
    );
    expect(out).toContain("+</html>");
    expect(out).not.toContain("[EVIDENCE-INCOMPLETE]");
  });

  it("appends the typed incompleteness marker when the changeset was truncated", () => {
    // PROMPT-INTEGRITY: a capture-layer cut must reach the judge as the typed
    // [EVIDENCE-INCOMPLETE] marker its prompt contract keys on, not a bare
    // parenthetical it can read past.
    const out = renderChangeSetBody(
      cs({
        changedFiles: ["a.ts"],
        diffStat: "1",
        diff: "+x",
        truncated: true,
      }),
    );
    const lastLine = out.split("\n").at(-1) ?? "";
    expect(lastLine.startsWith("[EVIDENCE-INCOMPLETE]")).toBe(true);
    expect(lastLine).toContain("changeset incomplete");
    expect(lastLine).toMatch(
      /MUST NOT be treated as missing work or as a defect/,
    );
  });
});
