/**
 * Browser action-begin tests exercise the last server-side confirmation and
 * action-lease boundary before a companion may perform a browser side effect.
 */
import type {
  BrowserBridgeAction,
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";
import { describe, expect, it, vi } from "vitest";
import type { LifeOpsBrowserSession } from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  BrowserDomain,
  type BrowserDomainDeps,
  browserSessionActionsDigest,
  MAX_BROWSER_SESSION_APPROVAL_AGE_MS,
} from "./browser-service.js";

const companion = {
  id: "companion-1",
  browser: "chrome",
  profileId: "profile-1",
} as BrowserBridgeCompanionStatus;

const settings: BrowserBridgeSettings = {
  enabled: true,
  trackingMode: "active_tabs",
  allowBrowserControl: true,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "all_sites",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

function browserAction(
  overrides: Partial<BrowserBridgeAction> = {},
): BrowserBridgeAction {
  return {
    id: "action-1",
    kind: "click",
    label: "Submit account change",
    url: "https://allowed.example/account",
    selector: "button",
    text: null,
    accountAffecting: true,
    requiresConfirmation: false,
    metadata: {},
    ...overrides,
  };
}

function browserSession(
  action: BrowserBridgeAction,
  metadata: Record<string, unknown> = {},
): LifeOpsBrowserSession {
  return {
    id: "session-1",
    agentId: "agent-1",
    domain: "browser",
    subjectType: "owner",
    subjectId: "owner",
    visibilityScope: "owner",
    contextPolicy: "owner_private",
    workflowId: null,
    browser: "chrome",
    companionId: companion.id,
    profileId: companion.profileId,
    windowId: null,
    tabId: null,
    title: "Account update",
    status: "running",
    actions: [action],
    currentActionIndex: 0,
    awaitingConfirmationForActionId: null,
    result: {},
    metadata,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    finishedAt: null,
  };
}

function harness(args: {
  action?: BrowserBridgeAction;
  beginResult?: "leased" | "blocked";
  sessionMetadata?: Record<string, unknown>;
  settings?: BrowserBridgeSettings;
}) {
  const action = args.action ?? browserAction();
  const session = browserSession(action, args.sessionMetadata);
  const requireConfirmation = vi.fn(async () => ({
    ...session,
    status: "awaiting_confirmation" as const,
    awaitingConfirmationForActionId: action.id,
  }));
  const begin = vi.fn(async () =>
    args.beginResult === "blocked"
      ? null
      : {
          ...session,
          metadata: {
            ...session.metadata,
            browserActionAttempt: { actionId: action.id },
          },
        },
  );
  const context = {
    agentId: () => "agent-1",
    repository: {
      requireBrowserSessionActionConfirmation: requireConfirmation,
      beginBrowserSessionActionFromCompanion: begin,
    },
  } as unknown as LifeOpsContext;
  const deps = {
    recordBrowserAudit: vi.fn(async () => undefined),
    requireBrowserAvailableForActions: vi.fn(
      async () => args.settings ?? settings,
    ),
  } as unknown as BrowserDomainDeps;
  const domain = new BrowserDomain(context, deps);
  vi.spyOn(domain, "requireBrowserCompanion").mockResolvedValue(companion);
  vi.spyOn(domain, "requireBrowserSessionForCompanion").mockResolvedValue(
    session,
  );
  return {
    action,
    audit: deps.recordBrowserAudit,
    begin,
    domain,
    requireConfirmation,
    session,
  };
}

const beginRequest = {
  currentActionIndex: 0,
  actionId: "action-1",
  attemptId: "attempt-1",
};

describe("BrowserDomain action begin", () => {
  it("re-gates a previously queued account action under current settings", async () => {
    const { begin, domain, requireConfirmation } = harness({});
    await expect(
      domain.beginBrowserSessionActionFromCompanion(
        companion.id,
        "token",
        "session-1",
        beginRequest,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(requireConfirmation).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
  });

  it("accepts an approval bound to the exact immutable action set", async () => {
    const action = browserAction();
    const { begin, domain } = harness({
      action,
      sessionMetadata: {
        browserApproval: {
          actionsDigest: browserSessionActionsDigest([action]),
          confirmedAt: new Date().toISOString(),
        },
      },
    });
    await expect(
      domain.beginBrowserSessionActionFromCompanion(
        companion.id,
        "token",
        "session-1",
        beginRequest,
      ),
    ).resolves.toMatchObject({ id: "session-1" });
    expect(begin).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "expired",
      new Date(
        Date.now() - MAX_BROWSER_SESSION_APPROVAL_AGE_MS - 1,
      ).toISOString(),
    ],
    ["malformed", "not-a-timestamp"],
    ["future", new Date(Date.now() + 60_000).toISOString()],
  ])("rejects a %s owner approval", async (_label, confirmedAt) => {
    const action = browserAction();
    const { begin, domain, requireConfirmation } = harness({
      action,
      sessionMetadata: {
        browserApproval: {
          actionsDigest: browserSessionActionsDigest([action]),
          confirmedAt,
        },
      },
    });

    await expect(
      domain.beginBrowserSessionActionFromCompanion(
        companion.id,
        "token",
        "session-1",
        beginRequest,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(requireConfirmation).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
  });

  it("still requires explicit action confirmation when account policy is off", async () => {
    const action = browserAction({
      accountAffecting: false,
      requiresConfirmation: true,
    });
    const { begin, domain, requireConfirmation } = harness({
      action,
      settings: {
        ...settings,
        requireConfirmationForAccountAffecting: false,
      },
    });
    await expect(
      domain.beginBrowserSessionActionFromCompanion(
        companion.id,
        "token",
        "session-1",
        beginRequest,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(requireConfirmation).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
  });

  it("records the authenticated companion when an action lease is blocked", async () => {
    const action = browserAction({ accountAffecting: false });
    const { audit, domain } = harness({ action, beginResult: "blocked" });
    await expect(
      domain.beginBrowserSessionActionFromCompanion(
        companion.id,
        "token",
        "session-1",
        beginRequest,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(audit).toHaveBeenCalledWith(
      "browser_session_updated",
      "session-1",
      expect.any(String),
      expect.objectContaining({ companionId: companion.id }),
      expect.objectContaining({ requiresOwnerRelease: true }),
    );
  });
});

describe("BrowserDomain companion completion", () => {
  it("rejects a runtime status outside done or failed before persistence", async () => {
    const action = browserAction({ accountAffecting: false });
    const session = browserSession(action, {
      browserActionAttempt: {
        actionId: action.id,
        actionIndex: 0,
        attemptId: "attempt-1",
      },
    });
    const complete = vi.fn();
    const context = {
      agentId: () => "agent-1",
      repository: {
        completeBrowserSessionFromCompanion: complete,
      },
    } as unknown as LifeOpsContext;
    const domain = new BrowserDomain(context, {
      recordBrowserAudit: vi.fn(),
    } as unknown as BrowserDomainDeps);
    vi.spyOn(domain, "requireBrowserCompanion").mockResolvedValue(companion);
    vi.spyOn(domain, "requireBrowserSessionForCompanion").mockResolvedValue(
      session,
    );

    await expect(
      domain.completeBrowserSessionFromCompanion(
        companion.id,
        "token",
        session.id,
        {
          status: "cancelled",
          currentActionIndex: 0,
          completedActionId: action.id,
          attemptId: "attempt-1",
        } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(complete).not.toHaveBeenCalled();
  });
});
