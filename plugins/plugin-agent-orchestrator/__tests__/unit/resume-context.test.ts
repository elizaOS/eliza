/**
 * Unit tests for the rate-limit / capacity failover resume-context module.
 *
 * Covers:
 *  - reason classification round-trips (rate-limited / needs-reauth / capacity)
 *  - buildResumeContext normalization (dedupe + cap changedFiles, clamp/trim
 *    lastProgress, blank-field pruning, deterministic `now`)
 *  - readResumeContext defensive coercion (malformed / partial / wrong-kind →
 *    undefined; valid metadata round-trips)
 *  - buildResumePreamble / applyResumePreamble text construction (continue-not-
 *    restart contract, optional-field inclusion, blank-task edge)
 *  - resumeEventFields shape (the event-surface item 4 depends on)
 *
 * Deterministic; no runtime, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  applyResumePreamble,
  buildResumeContext,
  buildResumePreamble,
  MAX_RESUME_CHANGED_FILES,
  MAX_RESUME_PROGRESS_CHARS,
  RESUME_CONTEXT_METADATA_KEY,
  type ResumeContext,
  readResumeContext,
  resumeEventFields,
} from "../../src/services/resume-context.js";

const BASE = {
  fromSessionId: "sess-1",
  workdir: "/work/repo",
} as const;

describe("resume-context: buildResumeContext", () => {
  it("builds a well-formed marker for a rate-limit failover", () => {
    const ctx = buildResumeContext({
      reason: "rate-limited",
      authReason: "token_expired",
      ...BASE,
      branch: "feat/x",
      diffStat: "2 files changed, 10 insertions(+)",
      changedFiles: ["a.ts", "b.ts"],
      lastProgress: "wrote a.ts",
      now: 1000,
    });
    expect(ctx).toEqual({
      kind: "rate-limit-failover",
      reason: "rate-limited",
      authReason: "token_expired",
      fromSessionId: "sess-1",
      workdir: "/work/repo",
      branch: "feat/x",
      diffStat: "2 files changed, 10 insertions(+)",
      changedFiles: ["a.ts", "b.ts"],
      lastProgress: "wrote a.ts",
      capturedAt: 1000,
    });
  });

  it.each([
    "rate-limited",
    "needs-reauth",
    "capacity",
  ] as const)("carries the %s reason through", (reason) => {
    const ctx = buildResumeContext({ reason, ...BASE });
    expect(ctx.reason).toBe(reason);
    expect(resumeEventFields(ctx).resumeReason).toBe(reason);
  });

  it("dedupes and caps changedFiles, trimming blanks", () => {
    const many = Array.from(
      { length: MAX_RESUME_CHANGED_FILES + 20 },
      (_, i) => `file-${i}.ts`,
    );
    const ctx = buildResumeContext({
      reason: "rate-limited",
      ...BASE,
      changedFiles: [" a.ts ", "a.ts", "", "  ", ...many],
    });
    expect(ctx.changedFiles).toHaveLength(MAX_RESUME_CHANGED_FILES);
    // dedupe collapsed " a.ts " and "a.ts" to one entry, blanks removed
    expect(ctx.changedFiles?.filter((f) => f === "a.ts")).toHaveLength(1);
    expect(ctx.changedFiles).not.toContain("");
  });

  it("clamps an over-long lastProgress and marks it truncated", () => {
    const long = "x".repeat(MAX_RESUME_PROGRESS_CHARS + 500);
    const ctx = buildResumeContext({
      reason: "rate-limited",
      ...BASE,
      lastProgress: long,
    });
    expect(ctx.lastProgress).toHaveLength(MAX_RESUME_PROGRESS_CHARS + 1); // +ellipsis
    expect(ctx.lastProgress?.endsWith("…")).toBe(true);
  });

  it("prunes blank optional fields to undefined", () => {
    const ctx = buildResumeContext({
      reason: "rate-limited",
      ...BASE,
      branch: "   ",
      diffStat: "",
      changedFiles: ["", "  "],
      lastProgress: null,
    });
    expect(ctx.branch).toBeUndefined();
    expect(ctx.diffStat).toBeUndefined();
    expect(ctx.changedFiles).toBeUndefined();
    expect(ctx.lastProgress).toBeUndefined();
  });

  it("defaults capturedAt to Date.now when now is absent/invalid", () => {
    const before = Date.now();
    const ctx = buildResumeContext({ reason: "capacity", ...BASE });
    expect(ctx.capturedAt).toBeGreaterThanOrEqual(before);
    const nanCtx = buildResumeContext({
      reason: "capacity",
      ...BASE,
      now: Number.NaN,
    });
    expect(Number.isFinite(nanCtx.capturedAt)).toBe(true);
  });
});

describe("resume-context: readResumeContext round-trip + coercion", () => {
  it("round-trips a marker through a metadata bag", () => {
    const ctx = buildResumeContext({
      reason: "needs-reauth",
      ...BASE,
      branch: "b",
      changedFiles: ["a.ts"],
      lastProgress: "did a thing",
      now: 42,
    });
    const bag = { [RESUME_CONTEXT_METADATA_KEY]: ctx };
    const read = readResumeContext(bag[RESUME_CONTEXT_METADATA_KEY]);
    expect(read).toEqual(ctx);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "resumeContext"],
    ["a number", 7],
    ["wrong kind", { kind: "something-else", reason: "rate-limited" }],
    ["bad reason", { kind: "rate-limit-failover", reason: "nope" }],
    [
      "missing fromSessionId",
      { kind: "rate-limit-failover", reason: "rate-limited", workdir: "/w" },
    ],
    [
      "missing workdir",
      {
        kind: "rate-limit-failover",
        reason: "rate-limited",
        fromSessionId: "s",
      },
    ],
  ])("reads %s as undefined", (_label, value) => {
    expect(readResumeContext(value)).toBeUndefined();
  });

  it.each([
    ["bad authReason", { authReason: "needs_reauth" }],
    ["non-string branch", { branch: 123 }],
    ["blank branch", { branch: " " }],
    ["non-string diffStat", { diffStat: 123 }],
    ["non-string lastProgress", { lastProgress: 123 }],
    ["blank lastProgress", { lastProgress: " " }],
    ["changedFiles is not an array", { changedFiles: "a.ts" }],
    ["changedFiles contains non-string", { changedFiles: ["a.ts", 5] }],
    ["changedFiles contains blank", { changedFiles: ["a.ts", " "] }],
    ["missing capturedAt", {}],
    ["non-finite capturedAt", { capturedAt: Number.NaN }],
  ])("rejects malformed optional metadata: %s", (_label, extra) => {
    expect(
      readResumeContext({
        kind: "rate-limit-failover",
        reason: "rate-limited",
        fromSessionId: "s1",
        workdir: "/w",
        ...extra,
      }),
    ).toBeUndefined();
  });

  it("trims valid persisted strings without accepting malformed values", () => {
    const read = readResumeContext({
      kind: "rate-limit-failover",
      reason: "needs-reauth",
      authReason: "token_expired",
      fromSessionId: " s1 ",
      workdir: " /w ",
      branch: " feat/x ",
      changedFiles: [" a.ts ", " b.ts "],
      lastProgress: " edited a ",
      capturedAt: 42,
    });
    expect(read).toMatchObject({
      reason: "needs-reauth",
      authReason: "token_expired",
      fromSessionId: "s1",
      workdir: "/w",
      branch: "feat/x",
      changedFiles: ["a.ts", "b.ts"],
      lastProgress: "edited a",
      capturedAt: 42,
    });
  });
});

describe("resume-context: preamble construction", () => {
  const full: ResumeContext = {
    kind: "rate-limit-failover",
    reason: "rate-limited",
    fromSessionId: "s1",
    workdir: "/w",
    branch: "feat/x",
    diffStat: "3 files changed",
    changedFiles: ["src/a.ts", "src/b.ts"],
    lastProgress: "implemented a, started b",
    capturedAt: 1,
  };

  it("tells the successor to continue, not restart", () => {
    const p = buildResumePreamble(full);
    expect(p).toContain("RESUMING AFTER FAILOVER");
    expect(p).toContain("rate limit");
    expect(p).toMatch(/Do NOT start over/i);
    expect(p).toContain("git status");
  });

  it("includes the optional branch / diffStat / files / progress when present", () => {
    const p = buildResumePreamble(full);
    expect(p).toContain("feat/x");
    expect(p).toContain("3 files changed");
    expect(p).toContain("src/a.ts");
    expect(p).toContain("src/b.ts");
    expect(p).toContain("implemented a, started b");
  });

  it("omits optional sections cleanly when absent", () => {
    const minimal: ResumeContext = {
      kind: "rate-limit-failover",
      reason: "capacity",
      fromSessionId: "s1",
      workdir: "/w",
      capturedAt: 1,
    };
    const p = buildResumePreamble(minimal);
    expect(p).toContain("capacity/overload");
    expect(p).not.toContain("Working branch");
    expect(p).not.toContain("Files already touched");
    expect(p).not.toContain("last progress summary");
    // still instructs discovery-first
    expect(p).toContain("git status");
  });

  it("applyResumePreamble prepends to the original task with a separator", () => {
    const composed = applyResumePreamble("Do the original thing", full);
    expect(composed).toContain("RESUMING AFTER FAILOVER");
    expect(composed).toContain("Original task:");
    expect(composed).toContain("Do the original thing");
    // preamble precedes the original
    expect(composed.indexOf("RESUMING AFTER FAILOVER")).toBeLessThan(
      composed.indexOf("Do the original thing"),
    );
  });

  it("applyResumePreamble returns just the preamble for a blank task", () => {
    const composed = applyResumePreamble("   ", full);
    expect(composed).toBe(buildResumePreamble(full));
    expect(composed).not.toContain("Original task:");
  });
});

describe("resume-context: resumeEventFields", () => {
  it("returns the resumable event surface (item 4)", () => {
    const ctx = buildResumeContext({
      reason: "rate-limited",
      ...BASE,
    });
    expect(resumeEventFields(ctx)).toEqual({
      resumable: true,
      resumeReason: "rate-limited",
      authReason: undefined,
      resumeFromSessionId: "sess-1",
    });
  });

  it("carries token expiry as trigger metadata, separate from the outcome event", () => {
    const ctx = buildResumeContext({
      reason: "needs-reauth",
      authReason: "token_expired",
      ...BASE,
    });
    expect(resumeEventFields(ctx)).toEqual({
      resumable: true,
      resumeReason: "needs-reauth",
      authReason: "token_expired",
      resumeFromSessionId: "sess-1",
    });
  });
});
