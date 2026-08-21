/**
 * Unit coverage for SandboxAuditLog and the process-wide audit feed —
 * append-only recording, trimming, query filters, subscriptions, and the
 * token-replacement/capability/policy helpers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAuditFeedForTests,
  getAuditFeedSize,
  queryAuditFeed,
  SandboxAuditLog,
  subscribeAuditFeed,
} from "./audit-log.ts";

describe("SandboxAuditLog", () => {
  beforeEach(() => {
    __resetAuditFeedForTests();
  });

  it("records an entry with a timestamp", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({
      type: "policy_decision",
      summary: "deny: not allowed",
      severity: "warn",
    });
    expect(log.size).toBe(1);
    const entry = log.getRecent(1)[0];
    expect(entry.timestamp).toBeTruthy();
    expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
    expect(entry.type).toBe("policy_decision");
  });

  it("trims to maxEntries when exceeded, keeping the newest entries", () => {
    const log = new SandboxAuditLog({ console: false, maxEntries: 10 });
    for (let i = 0; i < 20; i++) {
      log.record({
        type: "sandbox_lifecycle",
        summary: `event ${i}`,
        severity: "info",
      });
    }
    // Each overflow keeps the newest floor(max/2) entries. The second trim
    // happens at event 16, then events 17-19 append normally.
    expect(log.size).toBe(8);
    const summaries = log.getRecent(100).map((e) => e.summary);
    expect(summaries).toEqual([
      "event 12",
      "event 13",
      "event 14",
      "event 15",
      "event 16",
      "event 17",
      "event 18",
      "event 19",
    ]);
  });

  it("records token replacement with metadata (outbound)", () => {
    const log = new SandboxAuditLog({ console: false });
    log.recordTokenReplacement("outbound", "https://api.x.com", [
      "tok-1",
      "tok-2",
    ]);
    const entry = log.getByType("secret_token_replacement_outbound")[0];
    expect(entry.metadata?.tokenCount).toBe(2);
    expect(entry.metadata?.tokenIds).toBe("tok-1,tok-2");
    expect(entry.metadata?.url).toBe("https://api.x.com");
  });

  it("records token replacement (inbound)", () => {
    const log = new SandboxAuditLog({ console: false });
    log.recordTokenReplacement("inbound", "https://api.x.com", ["tok-1"]);
    expect(
      log.getByType("secret_sanitization_inbound")[0].metadata?.tokenCount,
    ).toBe(1);
  });

  it("records capability invocation", () => {
    const log = new SandboxAuditLog({ console: false });
    log.recordCapabilityInvocation("shell.exec", "ran ls", { cwd: "/tmp" });
    const entry = log.getByType("privileged_capability_invocation")[0];
    expect(entry.summary).toBe("shell.exec: ran ls");
    expect(entry.metadata?.capability).toBe("shell.exec");
    expect(entry.metadata?.cwd).toBe("/tmp");
  });

  it("records policy decisions with severity mapping", () => {
    const log = new SandboxAuditLog({ console: false });
    log.recordPolicyDecision("allow", "in allowlist");
    log.recordPolicyDecision("deny", "denylisted");
    const allow = log.getByType("policy_decision")[0];
    const deny = log.getByType("policy_decision")[1];
    expect(allow.severity).toBe("info");
    expect(deny.severity).toBe("warn");
  });

  it("invokes a configured sink", () => {
    const sink = vi.fn();
    const log = new SandboxAuditLog({ console: false, sink });
    log.record({
      type: "security_kill_switch",
      summary: "kill",
      severity: "critical",
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].type).toBe("security_kill_switch");
  });

  it("getRecent returns the newest N", () => {
    const log = new SandboxAuditLog({ console: false });
    for (let i = 0; i < 5; i++) {
      log.record({
        type: "sandbox_lifecycle",
        summary: `e${i}`,
        severity: "info",
      });
    }
    const recent = log.getRecent(2);
    expect(recent.map((entry) => entry.summary)).toEqual(["e3", "e4"]);
  });

  it("getByType filters by type", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    log.record({ type: "fetch_proxy_error", summary: "b", severity: "error" });
    log.record({ type: "sandbox_lifecycle", summary: "c", severity: "info" });
    expect(log.getByType("sandbox_lifecycle")).toHaveLength(2);
    expect(log.getByType("fetch_proxy_error")).toHaveLength(1);
  });

  it("clear empties entries", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    log.clear();
    expect(log.size).toBe(0);
  });
});

describe("audit feed (process-wide)", () => {
  beforeEach(() => {
    __resetAuditFeedForTests();
  });

  it("publishes records to the shared feed", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "policy_decision", summary: "x", severity: "info" });
    expect(getAuditFeedSize()).toBe(1);
  });

  it("filters by type and severity", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "policy_decision", summary: "a", severity: "info" });
    log.record({ type: "fetch_proxy_error", summary: "b", severity: "error" });
    const byType = queryAuditFeed({ type: "policy_decision" });
    expect(byType).toHaveLength(1);
    const bySeverity = queryAuditFeed({ severity: "error" });
    expect(bySeverity).toHaveLength(1);
  });

  it("filters since a timestamp (inclusive)", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    const firstTs = Date.parse(log.getRecent(1)[0].timestamp);
    log.record({ type: "sandbox_lifecycle", summary: "b", severity: "info" });
    // Entries at or after firstTs are included (both were recorded at ~now).
    expect(queryAuditFeed({ sinceMs: firstTs }).length).toBeGreaterThanOrEqual(
      1,
    );
    // A far-future sinceMs excludes everything.
    expect(queryAuditFeed({ sinceMs: Date.now() + 60_000 })).toHaveLength(0);
  });

  it("bounds the limit", () => {
    const log = new SandboxAuditLog({ console: false });
    for (let i = 0; i < 5; i++) {
      log.record({
        type: "sandbox_lifecycle",
        summary: `e${i}`,
        severity: "info",
      });
    }
    expect(queryAuditFeed({ limit: 2 }).map((entry) => entry.summary)).toEqual([
      "e3",
      "e4",
    ]);
  });

  it("handles invalid sinceMs and limit gracefully", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    expect(queryAuditFeed({ sinceMs: Number.NaN })).toHaveLength(1);
    expect(queryAuditFeed({ limit: Number.NaN })).toHaveLength(1);
    expect(queryAuditFeed({ limit: 0 })).toHaveLength(1); // clamped to >= 1
  });

  it("subscribers receive entries and can unsubscribe", () => {
    const log = new SandboxAuditLog({ console: false });
    const handler = vi.fn();
    const unsubscribe = subscribeAuditFeed(handler);
    log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" });
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    log.record({ type: "sandbox_lifecycle", summary: "b", severity: "info" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("subscriber failures do not block recording", () => {
    const log = new SandboxAuditLog({ console: false });
    subscribeAuditFeed(() => {
      throw new Error("subscriber boom");
    });
    expect(() =>
      log.record({ type: "sandbox_lifecycle", summary: "a", severity: "info" }),
    ).not.toThrow();
    expect(getAuditFeedSize()).toBe(1);
  });
});
