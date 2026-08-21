/**
 * Durable-storage contract for `jobs.error` (#23117 review).
 *
 * Four properties are load-bearing and each is pinned against the real
 * formatter: the text never escapes the advertised ceiling, hostile throws
 * cannot make the formatter itself throw (it runs before the failed job is
 * written back), credentials are scrubbed before the value becomes durable,
 * and the public API summary carries no stack frames.
 */
import { describe, expect, test } from "bun:test";
import {
  finalizeJobErrorText,
  jobErrorSummary,
  jobErrorText,
  publicJobErrorSummary,
} from "./job-error-text";

const MAX = 4_000;

describe("jobErrorText — ceiling", () => {
  test("caps at exactly the advertised maximum, suffix included", () => {
    const error = new Error("x".repeat(10_000));
    const text = jobErrorText(error);
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(text.endsWith("… truncated")).toBe(true);
  });

  test("the same ceiling applies to pre-formatted text that bypasses jobErrorText", () => {
    const text = finalizeJobErrorText("y".repeat(10_000));
    expect(text.length).toBeLessThanOrEqual(MAX);
  });

  test("leaves a short stack untouched", () => {
    const text = jobErrorText(new Error("value.toISOString is not a function"));
    expect(text).toContain("value.toISOString is not a function");
    expect(text.endsWith("… truncated")).toBe(false);
  });
});

describe("jobErrorText — never throws before the job is written back", () => {
  test("a null-prototype throw is recorded, not propagated", () => {
    const hostile = Object.create(null);
    expect(() => jobErrorText(hostile)).not.toThrow();
    expect(jobErrorText(hostile).length).toBeGreaterThan(0);
  });

  test("a throwing stack accessor falls back to the message", () => {
    const error = new Error("underlying failure");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("hostile stack");
      },
    });
    expect(() => jobErrorText(error)).not.toThrow();
    expect(jobErrorText(error)).toContain("underlying failure");
  });

  test("a throwing cause accessor ends the chain instead of propagating", () => {
    const error = new Error("outer");
    Object.defineProperty(error, "cause", {
      get() {
        throw new Error("hostile cause");
      },
    });
    expect(() => jobErrorText(error)).not.toThrow();
    expect(jobErrorText(error)).toContain("outer");
  });

  test("hostile and revoked Proxies cannot escape Error classification", () => {
    const prototypeHostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
      get() {
        throw new Error("hostile property read");
      },
    });
    const { proxy: revoked, revoke } = Proxy.revocable(new Error("revoked"), {});
    revoke();

    for (const hostile of [prototypeHostile, revoked]) {
      expect(() => jobErrorText(hostile)).not.toThrow();
      expect(() => jobErrorSummary(hostile)).not.toThrow();
      expect(jobErrorText(hostile).length).toBeGreaterThan(0);
      expect(jobErrorSummary(hostile).length).toBeGreaterThan(0);
    }
  });
});

describe("jobErrorText — redaction before durable storage", () => {
  test("a bearer credential in the message does not reach the column", () => {
    const text = jobErrorText(
      new Error("Authorization: Bearer sk-live-abcdef0123456789abcdef0123456789"),
    );
    expect(text).not.toContain("sk-live-abcdef0123456789abcdef0123456789");
  });
});

describe("jobErrorText — cause chain", () => {
  test("retains a wrapped cause that a native stack would drop", () => {
    const root = new Error("ENOENT: /srv/data/missing");
    const wrapped = new Error("agent_delete failed", { cause: root });
    const text = jobErrorText(wrapped);
    expect(text).toContain("agent_delete failed");
    expect(text).toContain("ENOENT: /srv/data/missing");
  });

  test("a cyclic cause chain terminates", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => jobErrorText(a)).not.toThrow();
    expect(jobErrorText(a).length).toBeLessThanOrEqual(MAX);
  });
});

describe("jobErrorSummary — safe to embed in a wrapper's message", () => {
  test("carries no frames, so wrapping does not consume the job budget", () => {
    const inner = new Error("inner failure");
    expect(jobErrorSummary(inner)).toBe("inner failure");
    expect(jobErrorSummary(inner)).not.toMatch(/\n\s+at /);
  });

  test("a thrown plain object keeps its content instead of [object Object]", () => {
    const payload = { code: -32000, message: "provisioner refused" };
    const text = jobErrorText(payload);
    expect(text).not.toBe("[object Object]");
    expect(text).toContain("provisioner refused");
  });
});

describe("publicJobErrorSummary — API boundary", () => {
  test("drops stack frames from what the owner can read", () => {
    const stored = jobErrorText(new Error("agent_delete failed"));
    expect(stored).toContain("\n    at ");
    const summary = publicJobErrorSummary(stored);
    expect(summary).toBe("Error: agent_delete failed");
    expect(summary).not.toContain("\n");
    expect(summary).not.toContain(" at ");
  });

  test("drops the frames' server paths, and keeps a multi-line message body", () => {
    // The frames are what disclose module layout; the message body is the
    // operator's own text and the owner needs it. Both halves asserted on a
    // stack that genuinely carries this file's absolute path.
    const stored = jobErrorText(
      new Error("Provisioning failed:\nnode: hetzner-3\nreason: no capacity"),
    );
    expect(stored).toContain("job-error-text.test.ts");
    const summary = publicJobErrorSummary(stored) ?? "";
    expect(summary).toContain("node: hetzner-3");
    expect(summary).toContain("reason: no capacity");
    expect(summary).not.toContain("job-error-text.test.ts");
    expect(summary).not.toMatch(/\n\s+at /);
  });

  test("a path inside the message itself is preserved — only frames are cut", () => {
    // Honest scope: this summary is not a path scrubber. An ENOENT message
    // names the file the operator asked about; the redactor handles secrets.
    const stored = jobErrorText(
      new Error("ENOENT: no such file, open '/srv/eliza/agents/9c1/config.json'"),
    );
    expect(publicJobErrorSummary(stored)).toContain("/srv/eliza/agents/9c1");
  });

  test("null and empty stay null", () => {
    expect(publicJobErrorSummary(null)).toBeNull();
    expect(publicJobErrorSummary(undefined)).toBeNull();
    expect(publicJobErrorSummary("   ")).toBeNull();
  });
});
