/**
 * Deterministic claimed-file verification (#16523): folding recorded tool
 * events into a write ledger, and cross-checking completion-report claims
 * against it — fail-closed (a claim with no successful ledger write is
 * unverified) but never false-flagging sessions with no structured ledger.
 */
import { describe, expect, it } from "vitest";
import {
  extractWriteLedger,
  type ToolLedgerEvent,
  verifyClaimedFiles,
} from "../services/claimed-file-verification.js";

function toolEvent(toolCall: Record<string, unknown>): ToolLedgerEvent {
  return { eventType: "tool_running", data: { toolCall } };
}

describe("extractWriteLedger", () => {
  it("classifies a completed edit as verified and a failed one as rejected", () => {
    const ledger = extractWriteLedger([
      toolEvent({
        id: "a",
        kind: "edit",
        rawInput: { file_path: "src/good.ts", new_string: "x" },
        status: "completed",
      }),
      toolEvent({
        id: "b",
        kind: "edit",
        rawInput: { file_path: "src/phantom.ts", new_string: "y" },
        status: "failed",
      }),
    ]);
    expect([...ledger.verified]).toEqual(["src/good.ts"]);
    expect([...ledger.rejected]).toEqual(["src/phantom.ts"]);
    expect(ledger.observed).toBe(true);
  });

  it("folds updates per call id: last status wins, path set is the union", () => {
    // The claude-agent-acp shape: initial tool_call with empty rawInput, an
    // enriched update carrying the path, then the terminal status update.
    const ledger = extractWriteLedger([
      toolEvent({ id: "a", kind: "edit", rawInput: {} }),
      toolEvent({
        id: "a",
        kind: "edit",
        rawInput: { file_path: "src/x.ts", new_string: "x" },
        status: "in_progress",
      }),
      toolEvent({ id: "a", kind: "edit", status: "completed" }),
    ]);
    expect([...ledger.verified]).toEqual(["src/x.ts"]);
    expect(ledger.rejected.size).toBe(0);
  });

  it("a successful retry verifies a path an earlier call had rejected", () => {
    // The stale-write-guard shape: first write refused (invalid_param), agent
    // re-reads and retries, second write completes.
    const ledger = extractWriteLedger([
      toolEvent({
        id: "first",
        kind: "write",
        rawInput: { file_path: "src/x.ts", content: "v1" },
        status: "failed",
      }),
      toolEvent({
        id: "retry",
        kind: "write",
        rawInput: { file_path: "src/x.ts", content: "v2" },
        status: "completed",
      }),
    ]);
    expect([...ledger.verified]).toEqual(["src/x.ts"]);
    expect(ledger.rejected.size).toBe(0);
  });

  it("writers with no recorded terminal status land in indeterminate, not rejected", () => {
    const ledger = extractWriteLedger([
      toolEvent({
        id: "a",
        kind: "edit",
        rawInput: { file_path: "src/x.ts", new_string: "x" },
        status: "in_progress",
      }),
    ]);
    expect([...ledger.indeterminate]).toEqual(["src/x.ts"]);
    expect(ledger.rejected.size).toBe(0);
    expect(ledger.verified.size).toBe(0);
  });

  it("ignores non-mutating calls and reports observed=false without any mutating ledger", () => {
    const ledger = extractWriteLedger([
      toolEvent({
        id: "r",
        kind: "read",
        rawInput: { file_path: "src/x.ts" },
        status: "completed",
      }),
      { eventType: "session_started", data: {} },
    ]);
    expect(ledger.observed).toBe(false);
  });

  it("collects paths from locations and treats write-content keys as mutating", () => {
    const ledger = extractWriteLedger([
      toolEvent({
        id: "a",
        kind: "other",
        rawInput: { patch: "@@" },
        locations: [{ path: "/abs/workdir/src/x.ts" }],
        status: "completed",
      }),
    ]);
    expect([...ledger.verified]).toEqual(["/abs/workdir/src/x.ts"]);
  });
});

describe("verifyClaimedFiles", () => {
  const ledger = extractWriteLedger([
    toolEvent({
      id: "ok",
      kind: "edit",
      rawInput: { file_path: "/work/repo/src/good.ts", new_string: "x" },
      status: "completed",
    }),
    toolEvent({
      id: "no",
      kind: "write",
      rawInput: { file_path: "src/phantom.ts", content: "y" },
      status: "error",
    }),
  ]);

  it("verifies claims by absolute-vs-relative suffix match", () => {
    const verdict = verifyClaimedFiles(["src/good.ts"], ledger);
    expect(verdict.verifiedClaims).toEqual(["src/good.ts"]);
    expect(verdict.unverifiedClaims).toEqual([]);
  });

  it("labels a rejected write and a never-written claim with distinct reasons", () => {
    const verdict = verifyClaimedFiles(
      ["src/phantom.ts", "src/invented.ts"],
      ledger,
    );
    expect(verdict.unverifiedClaims).toEqual([
      { path: "src/phantom.ts", reason: "rejected-write" },
      { path: "src/invented.ts", reason: "no-write-observed" },
    ]);
  });

  it("returns a non-actionable verdict when the session recorded no ledger", () => {
    const verdict = verifyClaimedFiles(["src/x.ts"], {
      verified: new Set(),
      rejected: new Set(),
      indeterminate: new Set(),
      observed: false,
    });
    expect(verdict.ledgerObserved).toBe(false);
    expect(verdict.verifiedClaims).toEqual([]);
    expect(verdict.unverifiedClaims).toEqual([]);
  });

  it("normalizes ./-prefixed and backslash claims and dedupes", () => {
    const verdict = verifyClaimedFiles(
      ["./src/good.ts", "src\\good.ts"],
      ledger,
    );
    expect(verdict.verifiedClaims).toEqual(["src/good.ts"]);
  });
});
