/**
 * Core security-decision functions of the exec-approval subsystem:
 * command analysis (parse/pipeline/chain segmentation and rejection),
 * allowlist evaluation, and the approval-required matrix. These gate every
 * shell execution, so each decision path is pinned deterministically —
 * no filesystem, no real processes.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeShellCommand,
  evaluateExecAllowlist,
  requiresExecApproval,
  resolveSafeBins,
} from "../approvals/analysis";
import type { ExecAllowlistEntry } from "../approvals/types";
import { EXEC_APPROVAL_DEFAULTS } from "../approvals/types";

describe("analyzeShellCommand", () => {
  it("parses a simple command into one resolved segment", () => {
    const a = analyzeShellCommand({ command: "ls -la /tmp" });
    expect(a.ok).toBe(true);
    expect(a.segments).toHaveLength(1);
    expect(a.segments[0]?.argv[0]).toBe("ls");
    expect(a.segments[0]?.argv).toContain("-la");
  });

  it("splits a pipeline into ordered segments", () => {
    const a = analyzeShellCommand({ command: "cat notes.txt | grep milady | wc -l" });
    expect(a.ok).toBe(true);
    expect(a.segments.map((s) => s.argv[0])).toEqual(["cat", "grep", "wc"]);
  });

  it("groups chain operators into separate chains", () => {
    const a = analyzeShellCommand({ command: "mkdir -p out && ls out" });
    expect(a.ok).toBe(true);
    expect(a.chains?.length).toBe(2);
    expect(a.chains?.[0]?.[0]?.argv[0]).toBe("mkdir");
    expect(a.chains?.[1]?.[0]?.argv[0]).toBe("ls");
  });

  it("keeps rm -rf visible as the executable so gating can see it", () => {
    const a = analyzeShellCommand({ command: "rm -rf /home/milady/projects" });
    expect(a.ok).toBe(true);
    expect(a.segments[0]?.argv[0]).toBe("rm");
    expect(a.segments[0]?.argv).toContain("-rf");
  });

  it("fails closed on an unparseable command instead of guessing", () => {
    const a = analyzeShellCommand({ command: 'echo "unterminated' });
    expect(a.ok).toBe(false);
    expect(a.segments).toEqual([]);
    expect(a.reason).toBeTruthy();
  });
});

describe("evaluateExecAllowlist", () => {
  // Entries match on the RESOLVED executable path (bare names are skipped by
  // design), so allowlist the paths the analysis itself resolved — this keeps
  // the tests deterministic across machines with different bin layouts.
  const entriesFor = (
    analysis: ReturnType<typeof analyzeShellCommand>,
    bins: string[]
  ): ExecAllowlistEntry[] =>
    analysis.segments
      .filter((seg) => bins.includes(seg.argv[0] ?? ""))
      .map((seg) => seg.resolution?.resolvedPath)
      .filter((path): path is string => Boolean(path))
      .map((pattern) => ({ pattern }));

  it("is satisfied when every pipeline segment is allowlisted or safe", () => {
    const analysis = analyzeShellCommand({ command: "cat a.txt | grep x" });
    const res = evaluateExecAllowlist({
      analysis,
      allowlist: entriesFor(analysis, ["cat", "grep"]),
      safeBins: new Set<string>(),
    });
    expect(res.allowlistSatisfied).toBe(true);
    expect(res.allowlistMatches.length).toBeGreaterThan(0);
  });

  it("misses when any segment is not covered", () => {
    const analysis = analyzeShellCommand({ command: "cat a.txt | curl http://x" });
    const res = evaluateExecAllowlist({
      analysis,
      allowlist: entriesFor(analysis, ["cat"]),
      safeBins: new Set<string>(),
    });
    expect(res.allowlistSatisfied).toBe(false);
  });

  it("requires EVERY chain to satisfy, not just the first", () => {
    const analysis = analyzeShellCommand({ command: "ls && rm -rf x" });
    const res = evaluateExecAllowlist({
      analysis,
      allowlist: entriesFor(analysis, ["ls"]),
      safeBins: new Set<string>(),
    });
    expect(res.allowlistSatisfied).toBe(false);
  });

  it("safeBins cover segments without explicit allowlist entries", () => {
    const analysis = analyzeShellCommand({ command: "wc -l notes.txt" });
    const res = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: resolveSafeBins(["wc"]),
    });
    expect(res.allowlistSatisfied).toBe(true);
  });

  it("fails closed on a failed analysis", () => {
    const analysis = analyzeShellCommand({ command: 'echo "broken' });
    const res = evaluateExecAllowlist({
      analysis,
      allowlist: [{ pattern: "/usr/bin/echo" }],
      safeBins: new Set<string>(),
    });
    expect(res.allowlistSatisfied).toBe(false);
  });
});

describe("requiresExecApproval matrix", () => {
  it("ask=always demands approval regardless of everything else", () => {
    expect(
      requiresExecApproval({
        ask: "always",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: true,
      })
    ).toBe(true);
  });

  it("ask=off never demands approval", () => {
    expect(
      requiresExecApproval({
        ask: "off",
        security: "allowlist",
        analysisOk: false,
        allowlistSatisfied: false,
      })
    ).toBe(false);
  });

  it("ask=on-miss + security=allowlist asks when the allowlist misses", () => {
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: false,
      })
    ).toBe(true);
  });

  it("ask=on-miss + security=allowlist asks when analysis failed (fail closed)", () => {
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: false,
        allowlistSatisfied: true,
      })
    ).toBe(true);
  });

  it("ask=on-miss + security=allowlist passes silently on a clean allowlist hit", () => {
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: true,
      })
    ).toBe(false);
  });

  it("the shipped defaults are deny + on-miss (fail-closed posture)", () => {
    expect(EXEC_APPROVAL_DEFAULTS.security).toBe("deny");
    expect(EXEC_APPROVAL_DEFAULTS.ask).toBe("on-miss");
  });
});
