/**
 * Deterministic unit coverage for the pure browser-session policy math:
 * domain-mode resolution ordering (disabled/paused/blocked pre-emption),
 * origin normalization and subdomain matching, submit/account-affecting
 * interception, TTL expiry, and credential redaction in receipts. No DOM,
 * no mocks — pure inputs to values.
 */
import { describe, expect, it } from "vitest";
import type { BrowserBridgeSettings } from "../../api/browser-contracts";
import type { BrowserBridgeSession } from "../../api/client-browser-bridge";
import {
  BROWSER_SESSION_TTL_MS,
  browserSessionExpiresAt,
  domainMatchesOrigin,
  interceptedSessionActions,
  isBrowserSessionExpired,
  normalizeOriginHost,
  resolveBrowserDomainPolicy,
  sessionRequiresTakeover,
  summarizeBrowserSessionReceipt,
} from "./browser-session-policy";

const NOW = "2026-08-20T12:00:00.000Z";

function settings(
  overrides: Partial<BrowserBridgeSettings> = {},
): BrowserBridgeSettings {
  return {
    enabled: true,
    trackingMode: "active_tabs",
    allowBrowserControl: true,
    requireConfirmationForAccountAffecting: true,
    incognitoEnabled: false,
    siteAccessMode: "granted_sites",
    grantedOrigins: [],
    blockedOrigins: [],
    maxRememberedTabs: 8,
    pauseUntil: null,
    metadata: {},
    updatedAt: NOW,
    ...overrides,
  };
}

function session(
  overrides: Partial<BrowserBridgeSession> = {},
): BrowserBridgeSession {
  return {
    id: "s-1",
    agentId: "agent-1",
    domain: "example.com",
    workflowId: null,
    browser: "chrome",
    companionId: null,
    profileId: null,
    windowId: null,
    tabId: null,
    title: "Book a table",
    status: "running",
    actions: [],
    currentActionIndex: 0,
    awaitingConfirmationForActionId: null,
    result: {},
    metadata: {},
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T11:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("normalizeOriginHost / domainMatchesOrigin", () => {
  it("normalizes scheme, path, port, and wildcard prefixes", () => {
    expect(normalizeOriginHost("https://Example.com/*")).toBe("example.com");
    expect(normalizeOriginHost("*.example.com")).toBe("example.com");
    expect(normalizeOriginHost("example.com:8443/path")).toBe("example.com");
    expect(normalizeOriginHost("   ")).toBeNull();
    expect(normalizeOriginHost("*.")).toBeNull();
  });

  it("matches exact hosts and subdomains, never suffix fragments", () => {
    expect(domainMatchesOrigin("example.com", "https://example.com")).toBe(
      true,
    );
    expect(domainMatchesOrigin("app.example.com", "example.com")).toBe(true);
    expect(domainMatchesOrigin("notexample.com", "example.com")).toBe(false);
    expect(domainMatchesOrigin("", "example.com")).toBe(false);
  });
});

describe("resolveBrowserDomainPolicy", () => {
  it("fails closed when the bridge or control is disabled", () => {
    expect(
      resolveBrowserDomainPolicy(
        "example.com",
        settings({ enabled: false }),
        NOW,
      ),
    ).toEqual({ mode: "bridge_disabled", allowed: false });
    expect(
      resolveBrowserDomainPolicy(
        "example.com",
        settings({ allowBrowserControl: false }),
        NOW,
      ),
    ).toEqual({ mode: "control_disabled", allowed: false });
  });

  it("reports paused while pauseUntil is in the future, then resumes", () => {
    const paused = settings({ pauseUntil: "2026-08-20T13:00:00.000Z" });
    expect(resolveBrowserDomainPolicy("example.com", paused, NOW).mode).toBe(
      "paused",
    );
    expect(
      resolveBrowserDomainPolicy(
        "example.com",
        paused,
        "2026-08-20T14:00:00.000Z",
      ).mode,
    ).toBe("outside_grants");
  });

  it("blocklist wins over every allow mode, including all_sites", () => {
    const verdict = resolveBrowserDomainPolicy(
      "trading.example.com",
      settings({
        siteAccessMode: "all_sites",
        blockedOrigins: ["example.com"],
      }),
      NOW,
    );
    expect(verdict).toEqual({ mode: "blocked", allowed: false });
  });

  it("resolves granted vs outside_grants under granted_sites mode", () => {
    const withGrant = settings({ grantedOrigins: ["https://example.com/*"] });
    expect(
      resolveBrowserDomainPolicy("app.example.com", withGrant, NOW),
    ).toEqual({ mode: "granted", allowed: true });
    expect(resolveBrowserDomainPolicy("other.com", withGrant, NOW)).toEqual({
      mode: "outside_grants",
      allowed: false,
    });
  });

  it("passes all_sites and current_site_only through as allowed", () => {
    expect(
      resolveBrowserDomainPolicy(
        "example.com",
        settings({ siteAccessMode: "all_sites" }),
        NOW,
      ),
    ).toEqual({ mode: "all_sites", allowed: true });
    expect(
      resolveBrowserDomainPolicy(
        "example.com",
        settings({ siteAccessMode: "current_site_only" }),
        NOW,
      ),
    ).toEqual({ mode: "current_site_only", allowed: true });
  });

  it("treats a missing or blank domain as unresolved, not allowed", () => {
    expect(resolveBrowserDomainPolicy(null, settings(), NOW)).toEqual({
      mode: "unresolved",
      allowed: false,
    });
    expect(resolveBrowserDomainPolicy("  ", settings(), NOW).mode).toBe(
      "unresolved",
    );
  });
});

describe("interception and takeover", () => {
  const submitAction = {
    id: "a-1",
    kind: "submit",
    label: "Submit order",
    url: null,
    selector: "#buy",
    text: null,
    accountAffecting: false,
    requiresConfirmation: false,
    metadata: {},
  };
  const clickAction = {
    ...submitAction,
    id: "a-2",
    kind: "click",
    label: "Open cart",
  };
  const flaggedAction = {
    ...clickAction,
    id: "a-3",
    label: "Transfer funds",
    accountAffecting: true,
  };
  const explicitAction = {
    ...clickAction,
    id: "a-4",
    label: "Post message",
    requiresConfirmation: true,
  };

  it("intercepts submit, account-affecting, and explicit-confirmation steps", () => {
    const s = session({
      actions: [submitAction, clickAction, flaggedAction, explicitAction],
    });
    const intercepted = interceptedSessionActions(s, settings());
    expect(intercepted.map((a) => a.id)).toEqual(["a-1", "a-3", "a-4"]);
  });

  it("keeps only explicit-confirmation steps when the setting is off", () => {
    const s = session({
      actions: [submitAction, flaggedAction, explicitAction],
    });
    const intercepted = interceptedSessionActions(
      s,
      settings({ requireConfirmationForAccountAffecting: false }),
    );
    expect(intercepted.map((a) => a.id)).toEqual(["a-4"]);
  });

  it("flags takeover only for awaiting_confirmation", () => {
    expect(
      sessionRequiresTakeover(session({ status: "awaiting_confirmation" })),
    ).toBe(true);
    expect(sessionRequiresTakeover(session({ status: "running" }))).toBe(false);
  });
});

describe("session TTL", () => {
  it("anchors expiry on finishedAt when present, else updatedAt", () => {
    const finished = session({
      status: "done",
      finishedAt: "2026-08-19T11:00:00.000Z",
    });
    expect(browserSessionExpiresAt(finished)).toBe(
      new Date(
        Date.parse("2026-08-19T11:00:00.000Z") + BROWSER_SESSION_TTL_MS,
      ).toISOString(),
    );
    expect(isBrowserSessionExpired(finished, NOW)).toBe(true);
  });

  it("never expires an unfinished session and tolerates bad timestamps", () => {
    expect(
      isBrowserSessionExpired(
        session({ status: "running", updatedAt: "2026-08-01T00:00:00.000Z" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      browserSessionExpiresAt(
        session({ status: "done", finishedAt: "not-a-date" }),
      ),
    ).toBeNull();
  });

  it("keeps a freshly finished session inside its window", () => {
    expect(
      isBrowserSessionExpired(
        session({ status: "done", finishedAt: "2026-08-20T11:59:00.000Z" }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("summarizeBrowserSessionReceipt", () => {
  it("redacts credential-looking keys unconditionally", () => {
    const entries = summarizeBrowserSessionReceipt(
      session({
        result: {
          orderId: "ORD-42",
          sessionToken: "sk-live-abc",
          Password: "hunter2",
          cookieJar: { a: 1 },
        },
      }),
    );
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.orderId).toEqual({
      key: "orderId",
      value: "ORD-42",
      redacted: false,
    });
    expect(byKey.sessionToken.value).toBe("[redacted]");
    expect(byKey.Password.value).toBe("[redacted]");
    expect(byKey.cookieJar.value).toBe("[redacted]");
  });

  it("stringifies and truncates long non-secret values", () => {
    const entries = summarizeBrowserSessionReceipt(
      session({
        result: {
          summary: "x".repeat(500),
          count: 3,
          detail: { pages: [1, 2, 3] },
        },
      }),
    );
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.summary.value.length).toBe(201);
    expect(byKey.summary.value.endsWith("…")).toBe(true);
    expect(byKey.count.value).toBe("3");
    expect(byKey.detail.value).toBe('{"pages":[1,2,3]}');
  });

  it("redacts credential-looking keys nested under benign keys", () => {
    const entries = summarizeBrowserSessionReceipt(
      session({
        result: {
          formData: {
            username: "shaw",
            password: "hunter2",
            extra: [{ apiKey: "sk-nested" }, "plain"],
          },
        },
      }),
    );
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.formData.value).not.toContain("hunter2");
    expect(byKey.formData.value).not.toContain("sk-nested");
    expect(byKey.formData.value).toContain("shaw");
    expect(byKey.formData.value).toContain("plain");
    expect(byKey.formData.value).toContain("[redacted]");
  });

  it("collapses over-deep nested payloads to the redaction marker", () => {
    let deep: Record<string, unknown> = { password: "leaky" };
    for (let i = 0; i < 20; i += 1) {
      deep = { wrap: deep };
    }
    const entries = summarizeBrowserSessionReceipt(
      session({ result: { audit: deep } }),
    );
    expect(entries[0]?.value).not.toContain("leaky");
    expect(entries[0]?.value).toContain("[redacted]");
  });
});
