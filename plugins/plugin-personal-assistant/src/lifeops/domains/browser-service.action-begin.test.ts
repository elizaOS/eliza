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
  const begin = vi.fn(async () => ({
    ...session,
    metadata: {
      ...session.metadata,
      browserActionAttempt: { actionId: action.id },
    },
  }));
  const context = {
    agentId: () => "agent-1",
    repository: {
      requireBrowserSessionActionConfirmation: requireConfirmation,
      beginBrowserSessionActionFromCompanion: begin,
    },
  } as unknown as LifeOpsContext;
  const deps = {
    requireBrowserAvailableForActions: vi.fn(
      async () => args.settings ?? settings,
    ),
  } as unknown as BrowserDomainDeps;
  const domain = new BrowserDomain(context, deps);
  vi.spyOn(domain, "requireBrowserCompanion").mockResolvedValue(companion);
  vi.spyOn(domain, "requireBrowserSessionForCompanion").mockResolvedValue(
    session,
  );
  return { action, begin, domain, requireConfirmation, session };
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
          confirmedAt: "2026-08-20T00:01:00.000Z",
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
});
