/**
 * Coverage for browser domain policy hooks — classifyBrowserCommandEffect,
 * policy registry (register/list/evaluate fail-closed), request builder and
 * the built-in allowlist policy. Pure helpers, no browser target needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserDomainPolicyRequest } from "./browser-domain-policy.js";
import {
  browserDomainPolicyRequestForCommand,
  classifyBrowserCommandEffect,
  createBrowserDomainAllowlistPolicy,
  evaluateBrowserDomainPolicies,
  listBrowserDomainPolicies,
  registerBrowserDomainPolicy,
  unregisterBrowserDomainPolicy,
} from "./browser-domain-policy.js";

function req(
  overrides: Partial<BrowserDomainPolicyRequest> = {},
): BrowserDomainPolicyRequest {
  return {
    subaction: "open",
    effect: "navigate",
    domain: "example.com",
    url: "https://example.com/",
    targetId: null,
    phase: "dispatch",
    ...overrides,
  } as BrowserDomainPolicyRequest;
}

describe("classifyBrowserCommandEffect", () => {
  it("classifies read, navigate, upload, eval and defaults to interact", () => {
    expect(classifyBrowserCommandEffect("list")).toBe("read");
    expect(classifyBrowserCommandEffect("screenshot")).toBe("read");
    expect(classifyBrowserCommandEffect("cursor-move")).toBe("read");
    expect(classifyBrowserCommandEffect("open")).toBe("navigate");
    expect(classifyBrowserCommandEffect("back")).toBe("navigate");
    expect(classifyBrowserCommandEffect("upload")).toBe("upload");
    expect(classifyBrowserCommandEffect("realistic-upload")).toBe("upload");
    expect(classifyBrowserCommandEffect("eval")).toBe("eval");
    expect(classifyBrowserCommandEffect("click")).toBe("interact");
    expect(classifyBrowserCommandEffect("UNKNOWN_NEW_MUTATING_ACTION")).toBe(
      "interact",
    );
  });

  it("is case-insensitive and trims", () => {
    expect(classifyBrowserCommandEffect("  EVAL ")).toBe("eval");
    expect(classifyBrowserCommandEffect(" Open ")).toBe("navigate");
    expect(classifyBrowserCommandEffect("SCREENSHOT")).toBe("read");
  });
});

describe("browser domain policy registry", () => {
  beforeEach(() => {
    for (const p of listBrowserDomainPolicies())
      unregisterBrowserDomainPolicy(p.id);
  });
  afterEach(() => {
    for (const p of listBrowserDomainPolicies())
      unregisterBrowserDomainPolicy(p.id);
  });

  it("allows all commands when no policy is registered", () => {
    const decision = evaluateBrowserDomainPolicies(req());
    expect(decision.verdict).toBe("allow");
    expect(decision.policyId).toBe("");
  });

  it("first non-allow wins and throwing policy blocks fail-closed", () => {
    registerBrowserDomainPolicy({
      id: "allow-all",
      evaluate: () => ({
        verdict: "allow",
        reason: "ok",
        policyId: "allow-all",
      }),
    });
    registerBrowserDomainPolicy({
      id: "thrower",
      evaluate: () => {
        throw new Error("boom");
      },
    });
    const blocked = evaluateBrowserDomainPolicies(req());
    expect(blocked.verdict).toBe("block");
    expect(blocked.policyId).toBe("thrower");
    expect(blocked.reason).toContain("boom");
  });

  it("blocks when policy returns non-object or invalid verdict", () => {
    registerBrowserDomainPolicy({
      id: "bad-return",
      evaluate: () =>
        null as unknown as ReturnType<
          BrowserDomainPolicyRequest extends never ? never : never
        >,
    } as unknown as import("./browser-domain-policy.js").BrowserDomainPolicy);
    expect(evaluateBrowserDomainPolicies(req()).verdict).toBe("block");
    unregisterBrowserDomainPolicy("bad-return");

    registerBrowserDomainPolicy({
      id: "bad-verdict",
      evaluate: () => ({
        verdict: "maybe" as unknown as "allow",
        reason: "x",
        policyId: "bad-verdict",
      }),
    });
    expect(evaluateBrowserDomainPolicies(req()).verdict).toBe("block");
  });

  it("blocks when decision getter throws", () => {
    registerBrowserDomainPolicy({
      id: "throwing-getter",
      evaluate: () =>
        ({
          get verdict() {
            throw new Error("getter boom");
          },
          reason: "x",
          policyId: "throwing-getter",
        }) as unknown as import("./browser-domain-policy.js").BrowserDomainPolicyDecision,
    } as unknown as import("./browser-domain-policy.js").BrowserDomainPolicy);
    const d = evaluateBrowserDomainPolicies(req());
    expect(d.verdict).toBe("block");
    expect(d.reason).toContain("getter boom");
  });

  it("rejects registration with empty id", () => {
    expect(() =>
      registerBrowserDomainPolicy({
        id: "   ",
        evaluate: () => ({ verdict: "allow", reason: "", policyId: "" }),
      }),
    ).toThrow(/non-empty id/);
  });
});

describe("browserDomainPolicyRequestForCommand", () => {
  it("builds dispatch-phase request with resolved domain", () => {
    const r = browserDomainPolicyRequestForCommand(
      {
        subaction: "open",
        url: "https://Example.COM./path",
      } as unknown as import("./workspace/browser-workspace-types.js").BrowserWorkspaceCommand,
      "target-1",
    );
    expect(r.subaction).toBe("open");
    expect(r.effect).toBe("navigate");
    expect(r.domain).toBe("example.com");
    expect(r.url).toBe("https://Example.COM./path");
    expect(r.targetId).toBe("target-1");
    expect(r.phase).toBe("dispatch");
  });

  it("nulls domain for non-http url and non-string url", () => {
    const r1 = browserDomainPolicyRequestForCommand(
      {
        subaction: "click",
        url: "file:///tmp/a.html",
      } as unknown as import("./workspace/browser-workspace-types.js").BrowserWorkspaceCommand,
      null,
    );
    expect(r1.domain).toBeNull();
    const r2 = browserDomainPolicyRequestForCommand(
      {
        subaction: "click",
      } as unknown as import("./workspace/browser-workspace-types.js").BrowserWorkspaceCommand,
      null,
    );
    expect(r2.domain).toBeNull();
    expect(r2.url).toBeNull();
  });
});

describe("createBrowserDomainAllowlistPolicy", () => {
  it("allows gated effect only on allowlisted domains (exact and subdomain)", () => {
    const policy = createBrowserDomainAllowlistPolicy({
      id: "allowlist",
      allowedDomains: ["example.com"],
    });
    expect(
      policy.evaluate(req({ domain: "example.com", effect: "navigate" }))
        .verdict,
    ).toBe("allow");
    expect(
      policy.evaluate(req({ domain: "login.example.com", effect: "navigate" }))
        .verdict,
    ).toBe("allow");
    expect(
      policy.evaluate(req({ domain: "evil.com", effect: "navigate" })).verdict,
    ).toBe("block");
    expect(
      policy.evaluate(req({ domain: "notexample.com", effect: "navigate" }))
        .verdict,
    ).toBe("block");
  });

  it("passes non-gated effects regardless of domain", () => {
    const policy = createBrowserDomainAllowlistPolicy({
      id: "a",
      allowedDomains: ["example.com"],
    });
    expect(
      policy.evaluate(req({ domain: "evil.com", effect: "read" })).verdict,
    ).toBe("allow");
    expect(policy.evaluate(req({ domain: null, effect: "read" })).verdict).toBe(
      "allow",
    );
  });

  it("fail-closes unknown domain for gated effects with configurable verdict", () => {
    const block = createBrowserDomainAllowlistPolicy({
      id: "a",
      allowedDomains: ["example.com"],
    });
    expect(
      block.evaluate(req({ domain: null, effect: "navigate" })).verdict,
    ).toBe("block");
    const confirm = createBrowserDomainAllowlistPolicy({
      id: "b",
      allowedDomains: ["example.com"],
      unknownDomainVerdict: "require_confirmation",
    });
    expect(
      confirm.evaluate(req({ domain: null, effect: "navigate" })).verdict,
    ).toBe("require_confirmation");
  });

  it("throws when no valid domain supplied", () => {
    expect(() =>
      createBrowserDomainAllowlistPolicy({
        id: "x",
        allowedDomains: ["   ", " . "],
      }),
    ).toThrow(/at least one valid domain/);
  });

  it("normalizes allowed domains (trim, lowercase, dots)", () => {
    const p = createBrowserDomainAllowlistPolicy({
      id: "n",
      allowedDomains: ["  EXAMPLE.COM. ", ".example.com"],
    });
    expect(
      p.evaluate(req({ domain: "example.com", effect: "navigate" })).verdict,
    ).toBe("allow");
    expect(
      p.evaluate(req({ domain: "sub.example.com", effect: "navigate" }))
        .verdict,
    ).toBe("allow");
  });

  it("respects custom gatedEffects set", () => {
    const p = createBrowserDomainAllowlistPolicy({
      id: "c",
      allowedDomains: ["example.com"],
      gatedEffects: ["upload"],
    });
    expect(
      p.evaluate(req({ domain: "evil.com", effect: "navigate" })).verdict,
    ).toBe("allow");
    expect(
      p.evaluate(req({ domain: "evil.com", effect: "upload" })).verdict,
    ).toBe("block");
  });
});
