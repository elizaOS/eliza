/**
 * Durable-storage contract for `jobs.error` (#23117 review).
 *
 * Four properties are load-bearing and each is pinned against the real
 * formatter: complete error evidence survives, hostile throws
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

const ownerCredentialFixture = (prefix: string): string =>
  `${prefix}${["legacy", "owner", "credential", "fixture"].join("-")}`;
const ownerProviderTokenFixture = (): string => ["provider returned ghp_", "a".repeat(36)].join("");

describe("jobErrorText — completeness", () => {
  test("preserves a long stack and message", () => {
    const error = new Error("x".repeat(10_000));
    const text = jobErrorText(error);
    expect(text).toContain("x".repeat(10_000));
  });

  test("pre-formatted text that bypasses jobErrorText remains complete", () => {
    const text = finalizeJobErrorText("y".repeat(10_000));
    expect(text).toBe("y".repeat(10_000));
  });

  test("leaves a short stack untouched", () => {
    const text = jobErrorText(new Error("value.toISOString is not a function"));
    expect(text).toContain("value.toISOString is not a function");
  });

  test("retains the message when a native subclass stack omits it", () => {
    const error = new Error("readiness probe transport_unresolved");
    error.name = "RetryableProvisionTransportError";
    error.stack = "Error\n    at executeAgentProvision (provisioning-jobs.ts:6553:19)";

    const text = jobErrorText(error);

    expect(text).toContain(
      "RetryableProvisionTransportError: readiness probe transport_unresolved",
    );
    expect(text).toContain("at executeAgentProvision");
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
    expect(jobErrorText(a)).toContain("[circular]");
  });

  test("retains cause chains beyond the retired depth window", () => {
    let error: Error = new Error("root-cause");
    for (let depth = 0; depth < 10; depth += 1) {
      error = new Error(`layer-${depth}`, { cause: error });
    }
    expect(jobErrorText(error)).toContain("root-cause");
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
  test("fails closed when legacy storage contains a stack", () => {
    const stored = jobErrorText(new Error("agent_delete failed"));
    expect(stored).toContain("\n    at ");
    const summary = publicJobErrorSummary(stored);
    expect(summary).toBe(
      "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
    );
  });

  test("keeps a benign multi-line message that contains no private diagnostic material", () => {
    const stored = "Provisioning failed:\nnode: unavailable\nreason: no capacity";
    const summary = publicJobErrorSummary(stored) ?? "";
    expect(summary).toContain("node: unavailable");
    expect(summary).toContain("reason: no capacity");
  });

  test.each([
    ownerCredentialFixture("Authorization: Bearer "),
    ownerCredentialFixture("X_API_KEY="),
    ownerCredentialFixture("CEREBRAS_API_KEY="),
    ownerCredentialFixture("access_token="),
    ownerProviderTokenFixture(),
    "NODE_ENV=production",
    "CUSTOM_VALUE=fixture-value",
    "request failed at http://100.64.23.9:3000/api/status",
    "request failed at http://10.0.0.4:3000/api/status",
    "request failed at http://172.20.0.1:3000/api/status",
    "request failed at http://192.168.1.2:3000/api/status",
    "request failed at http://127.0.0.1:3000/api/status",
    "request failed at http://169.254.169.254/latest/meta-data",
    "request failed at http://[fd00::1]:3000/api/status",
    "request failed at http://[::1]:3000/api/status",
    "request failed at http://[fe80::1]:3000/api/status",
    "request failed at http://db.internal:5432/status",
    "request failed at https://service.eliza.local/status",
  ])("re-sanitizes a legacy raw owner diagnostic: %s", (stored) => {
    expect(publicJobErrorSummary(stored)).toBe(
      "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
    );
  });

  test.each([
    "ENOENT: no such file, open '/srv/eliza/agents/9c1/config.json'",
    "ENOENT [/srv/eliza/agents/9c1/config.json]",
    "ENOENT: //srv/eliza/agents/9c1/config.json",
    "failed to create /tmp",
    "failed to read C:\\eliza\\agents\\9c1\\config.json",
    "failed to read \\\\internal-host\\agents\\9c1\\config.json",
    "failed to read file:///srv/eliza/agents/9c1/config.json",
    "failed at prefix/srv/eliza/agents/9c1/config.json",
    "failed at prefixC:\\eliza\\agents\\9c1\\config.json",
  ])("withholds a first-line absolute path from the owner: %s", (message) => {
    const stored = jobErrorText(new Error(message));
    const summary = publicJobErrorSummary(stored) ?? "";
    expect(summary).toBe(
      "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
    );
    expect(summary).not.toContain("9c1");
  });

  test.each([
    "Provider failed at https://api.eliza.app/v1/chat",
    "Provider failed at https://api.eliza.app/callback?next=/v1/chat",
    "Provider failed at https://api.eliza.app/v1//chat",
    "Provider failed at https://api.eliza.app/callback?next=%25252Fv1%25252Fchat",
    "Socket closed at wss://agent.example.test/chat",
  ])("does not mistake a public network URL for a host path: %s", (message) => {
    const stored = `Error: ${message}`;
    expect(publicJobErrorSummary(stored)).toBe(stored);
  });

  test("still finds a formatted host path adjacent to a public URL", () => {
    for (const stored of [
      "Provider https://api.eliza.app/v1/chat(/srv/eliza/agents/9c1/config.json)",
      "Provider https://api.eliza.app/callback[/workspace/eliza/agents/9c1/config.json]",
      "Provider https://api.eliza.app/v1/chat,%2Fsrv%2Feliza%2Fagents%2F9c1%2Fconfig.json",
      "Provider https://api.eliza.app/v1/chat;C:%5Celiza%5Cagents%5C9c1%5Cconfig.json",
    ]) {
      expect(publicJobErrorSummary(stored)).toBe(
        "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
      );
    }
  });

  test.each([
    "Provider https://api.eliza.app?debug=/srv/eliza/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=/workspace/eliza/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=/app/eliza/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=/data/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=/nix/store/secret/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=//internal-host/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=/callback/eliza/agents/9c1/config.json",
    "Provider https://api.eliza.app?debug=/v1/chat/private/agents/9c1/config.json",
    "Provider https://api.eliza.app(/srv/eliza/agents/9c1/config.json)",
    "Provider https://api.eliza.app,C:\\eliza\\agents\\9c1\\config.json",
    "Provider https://api.eliza.app?debug=%2Fsrv%2Feliza%2Fagents%2F9c1%2Fconfig.json",
    "Provider https://api.eliza.app?debug=%20%2Fsrv%2Feliza%2Fagents%2F9c1%2Fconfig.json",
    "Provider https://api.eliza.app?debug=%09%2Fworkspace%2Feliza%2Fagents%2F9c1%2Fconfig.json",
    "Provider https://api.eliza.app?%2Fsrv%2Feliza%2Fagents%2F9c1%2Fconfig.json=debug",
    "Provider https://api.eliza.app?debug=context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252F9c1%25252Fconfig.json",
    "Provider https://api.eliza.app?context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252F9c1%25252Fconfig.json=debug",
    "Provider https://api.eliza.app/#context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252F9c1%25252Fconfig.json",
    "Provider https://api.eliza.app?debug=prefix%25252Fsrv%25252Feliza%25252Fagents%25252F9c1%25252Fconfig.json",
    "Provider https://api.eliza.app?prefix%25252Fsrv%25252Feliza%25252Fagents%25252F9c1%25252Fconfig.json=debug",
    "Provider https://api.eliza.app/#prefix%25252Fsrv%25252Feliza%25252Fagents%25252F9c1%25252Fconfig.json",
    "Provider https://api.eliza.app?debug=%E0%A4%A/srv/eliza/agents/9c1/config.json",
  ])("withholds a host path carried beside or inside a public URL: %s", (message) => {
    const stored = jobErrorText(new Error(message));
    const summary = publicJobErrorSummary(stored) ?? "";
    expect(summary).toBe(
      "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
    );
    expect(summary).not.toContain("9c1");
  });

  test("null and empty stay null", () => {
    expect(publicJobErrorSummary(null)).toBeNull();
    expect(publicJobErrorSummary(undefined)).toBeNull();
    expect(publicJobErrorSummary("   ")).toBeNull();
  });
});
