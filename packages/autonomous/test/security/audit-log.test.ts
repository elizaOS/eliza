import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetAuditFeedForTests,
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  SandboxAuditLog,
  subscribeAuditFeed,
} from "../../src/security/audit-log";

beforeEach(() => {
  __resetAuditFeedForTests();
});

describe("SandboxAuditLog", () => {
  function createLog(config = {}) {
    return new SandboxAuditLog({ console: false, ...config });
  }

  test("records an entry and retrieves it", () => {
    const log = createLog();
    log.record({
      type: "policy_decision",
      summary: "allowed fetch",
      severity: "info",
    });
    const recent = log.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe("policy_decision");
    expect(recent[0].summary).toBe("allowed fetch");
    expect(recent[0].timestamp).toBeDefined();
  });

  test("getByType filters correctly", () => {
    const log = createLog();
    log.record({ type: "policy_decision", summary: "a", severity: "info" });
    log.record({ type: "sandbox_lifecycle", summary: "b", severity: "info" });
    log.record({ type: "policy_decision", summary: "c", severity: "warn" });

    const decisions = log.getByType("policy_decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.every((e) => e.type === "policy_decision")).toBe(true);
  });

  test("size tracks entry count", () => {
    const log = createLog();
    expect(log.size).toBe(0);
    log.record({ type: "policy_decision", summary: "a", severity: "info" });
    expect(log.size).toBe(1);
  });

  test("clear removes all entries", () => {
    const log = createLog();
    log.record({ type: "policy_decision", summary: "a", severity: "info" });
    log.clear();
    expect(log.size).toBe(0);
  });

  test("recordTokenReplacement creates outbound entry", () => {
    const log = createLog();
    log.recordTokenReplacement("outbound", "https://api.example.com", ["tok1"]);
    const recent = log.getRecent(1);
    expect(recent[0].type).toBe("secret_token_replacement_outbound");
    expect(recent[0].severity).toBe("info");
  });

  test("recordTokenReplacement creates inbound entry", () => {
    const log = createLog();
    log.recordTokenReplacement("inbound", "https://api.example.com", ["tok1"]);
    const recent = log.getRecent(1);
    expect(recent[0].type).toBe("secret_sanitization_inbound");
  });

  test("recordCapabilityInvocation creates correct entry", () => {
    const log = createLog();
    log.recordCapabilityInvocation("shell", "ran ls command");
    const recent = log.getRecent(1);
    expect(recent[0].type).toBe("privileged_capability_invocation");
    expect(recent[0].summary).toContain("shell");
  });

  test("recordPolicyDecision deny uses warn severity", () => {
    const log = createLog();
    log.recordPolicyDecision("deny", "blocked private IP");
    const recent = log.getRecent(1);
    expect(recent[0].type).toBe("policy_decision");
    expect(recent[0].severity).toBe("warn");
  });

  test("recordPolicyDecision allow uses info severity", () => {
    const log = createLog();
    log.recordPolicyDecision("allow", "public IP ok");
    const recent = log.getRecent(1);
    expect(recent[0].severity).toBe("info");
  });

  test("calls custom sink when provided", () => {
    const sink = vi.fn();
    const log = new SandboxAuditLog({ console: false, sink });
    log.record({
      type: "policy_decision",
      summary: "test",
      severity: "info",
    });
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0][0].type).toBe("policy_decision");
  });

  test("respects maxEntries limit", () => {
    const log = new SandboxAuditLog({ console: false, maxEntries: 3 });
    for (let i = 0; i < 10; i++) {
      log.record({
        type: "policy_decision",
        summary: `entry-${i}`,
        severity: "info",
      });
    }
    expect(log.size).toBeLessThanOrEqual(3);
  });

  test("getRecent returns most recent entries", () => {
    const log = createLog();
    log.record({ type: "policy_decision", summary: "first", severity: "info" });
    log.record({
      type: "sandbox_lifecycle",
      summary: "second",
      severity: "info",
    });
    log.record({
      type: "policy_decision",
      summary: "third",
      severity: "info",
    });

    const recent = log.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].summary).toBe("second");
    expect(recent[1].summary).toBe("third");
  });
});

describe("process-level audit feed", () => {
  test("queryAuditFeed returns empty initially", () => {
    expect(queryAuditFeed()).toEqual([]);
    expect(getAuditFeedSize()).toBe(0);
  });

  test("record publishes to global feed", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({
      type: "sandbox_lifecycle",
      summary: "started",
      severity: "info",
    });
    expect(getAuditFeedSize()).toBe(1);
    const entries = queryAuditFeed();
    expect(entries[0].type).toBe("sandbox_lifecycle");
  });

  test("queryAuditFeed filters by type", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "policy_decision", summary: "a", severity: "info" });
    log.record({ type: "sandbox_lifecycle", summary: "b", severity: "info" });

    const filtered = queryAuditFeed({ type: "policy_decision" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe("policy_decision");
  });

  test("queryAuditFeed filters by severity", () => {
    const log = new SandboxAuditLog({ console: false });
    log.record({ type: "policy_decision", summary: "a", severity: "info" });
    log.record({ type: "policy_decision", summary: "b", severity: "warn" });

    const filtered = queryAuditFeed({ severity: "warn" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].severity).toBe("warn");
  });

  test("queryAuditFeed respects limit", () => {
    const log = new SandboxAuditLog({ console: false });
    for (let i = 0; i < 10; i++) {
      log.record({
        type: "policy_decision",
        summary: `entry-${i}`,
        severity: "info",
      });
    }
    const limited = queryAuditFeed({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  test("subscribeAuditFeed receives new entries", () => {
    const received: unknown[] = [];
    const unsub = subscribeAuditFeed((entry) => received.push(entry));

    const log = new SandboxAuditLog({ console: false });
    log.record({
      type: "sandbox_lifecycle",
      summary: "started",
      severity: "info",
    });

    expect(received).toHaveLength(1);

    unsub();

    log.record({
      type: "sandbox_lifecycle",
      summary: "stopped",
      severity: "info",
    });
    // After unsub, no more entries should arrive
    expect(received).toHaveLength(1);
  });
});

describe("constants", () => {
  test("AUDIT_EVENT_TYPES has 12 entries", () => {
    expect(AUDIT_EVENT_TYPES.length).toBe(12);
  });

  test("AUDIT_SEVERITIES has 4 levels", () => {
    expect(AUDIT_SEVERITIES).toEqual(["info", "warn", "error", "critical"]);
  });
});
