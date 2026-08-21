/**
 * Extension service worker — the always-on coordinator. Runs the periodic sync
 * loop, pulls agent-directed browser sessions
 * and executes them via the content script, and enforces the website blocklist
 * through declarativeNetRequest. Bridges popup requests and content-script
 * responses to the BrowserBridgeRelayClient.
 *
 * Under MV3 the worker can be evicted between events, so durable state lives in
 * chrome.storage.local via src/storage.ts rather than in module scope.
 */
import { browserActionAuthorizationError } from "../src/action-authorization";
import { resolveBrowserActionTarget } from "../src/action-target";
import { BrowserBridgeRelayClient, RelayApiError } from "../src/api-client";
import type {
  BrowserBridgeAction,
  BrowserBridgeSettings,
  LifeOpsBrowserSession,
} from "../src/browser-bridge-contracts";
import { CoalescingSyncRunner } from "../src/coalescing-sync-runner";
import { sendWithContentScriptRecovery } from "../src/content-script-messaging";
import {
  BROWSER_BRIDGE_NATIVE_HOST,
  NativeEnrollmentCoordinator,
  NativeEnrollmentError,
  type NativeEnrollmentRequest,
} from "../src/native-enrollment";
import type {
  BackgroundState,
  CompanionConfig,
  CompanionPreflightRequest,
  CompanionSession,
  CompanionSyncRequest,
  ContentScriptResponse,
  DomActionRequest,
  PopupRequest,
  PopupResponse,
} from "../src/protocol";
import { withBrowserBridgeRequestTimeout } from "../src/request-timeout";
import {
  clearCompanionConfig,
  getOrCreateExtensionProfileId,
  isValidApiBaseUrl,
  loadBackgroundState,
  loadCompanionConfig,
  loadNativeEnrollmentState,
  normalizeCompanionConfig,
  persistCompanionConfig,
  resetNativeEnrollmentState,
  resumeNativeEnrollmentAfterOwnerDisconnect,
  saveBackgroundState,
  saveCompanionConfig,
  saveNativeEnrollmentState,
  suppressNativeEnrollment,
} from "../src/storage";
import {
  findFocusedTab,
  type RememberedTab,
  selectTabsForSync,
} from "../src/tab-cache";
import {
  addAlarmListener,
  addInstalledListener,
  addRuntimeMessageListener,
  addStartupListener,
  addTabsActivatedListener,
  addTabsRemovedListener,
  addTabsUpdatedListener,
  addWindowFocusListener,
  createAlarm,
  createTab,
  executeContentScriptFiles,
  focusWindow,
  getAllWindows,
  getDynamicRules,
  getExtensionId,
  getExtensionUrl,
  getGrantedOrigins,
  getManifestVersion,
  hasAllUrlHostPermission,
  hasManifestPermission,
  isIncognitoAccessAllowed,
  isPrivilegedExtensionSender,
  queryTabs,
  reloadTab,
  sendNativeMessage,
  sendTabMessage,
  updateDynamicRules,
  updateTab,
} from "../src/webextension";

declare const __BROWSER_BRIDGE_KIND__: "chrome" | "firefox" | "safari";

const SYNC_ALARM = "browser-bridge-sync";
const SYNC_INTERVAL_MINUTES = 0.5;
const SYNC_DEBOUNCE_MS = 750;
const MAX_REMEMBERED_TABS = 10;

let backgroundState: BackgroundState = {
  config: null,
  settings: null,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  lastSessionStatus: null,
  activeSessionId: null,
  rememberedTabCount: 0,
  settingsSummary: null,
  connectionIssue: null,
};
let rememberedTabs: RememberedTab[] = [];
let syncDebounceScheduled = false;
let activeSessionId: string | null = null;

const nativeEnrollment = new NativeEnrollmentCoordinator({
  getExtensionId,
  getExtensionVersion: getManifestVersion,
  send: async (request: NativeEnrollmentRequest) =>
    await sendNativeMessage<NativeEnrollmentRequest, unknown>(
      BROWSER_BRIDGE_NATIVE_HOST,
      request,
    ),
  loadState: loadNativeEnrollmentState,
  saveState: saveNativeEnrollmentState,
});

function canSyncUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function parseNumericId(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCompanionAuthError(error: unknown): error is RelayApiError {
  if (!(error instanceof RelayApiError) || error.status !== 401) {
    return false;
  }
  return (
    error.code === null ||
    error.code === "browser_bridge_companion_pairing_invalid" ||
    error.code === "browser_bridge_companion_token_expired" ||
    error.code === "browser_bridge_companion_token_revoked"
  );
}

function companionAuthErrorMessage(error: RelayApiError): string {
  if (error.code === "browser_bridge_companion_token_revoked") {
    return "Pairing was revoked. Create a new pairing in Eliza and import its pairing JSON.";
  }
  if (error.code === "browser_bridge_companion_token_expired") {
    return "Pairing expired. Create a new pairing in Eliza and import its pairing JSON.";
  }
  return "Pairing is no longer valid. Create a new pairing in Eliza and import its pairing JSON.";
}

async function saveState(): Promise<void> {
  backgroundState = {
    ...backgroundState,
    rememberedTabCount: rememberedTabs.length,
    activeSessionId,
  };
  await saveBackgroundState(backgroundState);
}

async function setState(next: Partial<BackgroundState>): Promise<void> {
  backgroundState = {
    ...backgroundState,
    ...next,
  };
  await saveState();
}

async function readConfig(): Promise<CompanionConfig | null> {
  const config = await loadCompanionConfig();
  backgroundState.config = config;
  return config;
}

async function describePermissionState(): Promise<{
  tabs: boolean;
  scripting: boolean;
  activeTab: boolean;
  allOrigins: boolean;
  grantedOrigins: string[];
  incognitoEnabled: boolean;
}> {
  return {
    tabs: true,
    scripting: true,
    activeTab: hasManifestPermission("activeTab"),
    allOrigins: await hasAllUrlHostPermission(),
    grantedOrigins: await getGrantedOrigins(),
    incognitoEnabled: await isIncognitoAccessAllowed(),
  };
}

async function collectSnapshotTabs(
  config: CompanionConfig,
  settings: BrowserBridgeSettings | null,
): Promise<RememberedTab[]> {
  const windows = await getAllWindows();
  const snapshot: RememberedTab[] = [];
  const nowIso = new Date().toISOString();
  for (const windowInfo of windows) {
    for (const tab of windowInfo.tabs ?? []) {
      if (!canSyncUrl(tab.url)) {
        continue;
      }
      if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
        continue;
      }
      snapshot.push({
        browser: config.browser,
        profileId: config.profileId,
        windowId: String(tab.windowId),
        tabId: String(tab.id),
        url: tab.url,
        title: tab.title?.trim() || tab.url,
        activeInWindow: tab.active === true,
        focusedWindow: windowInfo.focused === true,
        focusedActive: tab.active === true && windowInfo.focused === true,
        incognito: tab.incognito === true,
        faviconUrl: tab.favIconUrl ?? null,
        lastSeenAt: nowIso,
        lastFocusedAt: tab.active === true ? nowIso : null,
        metadata: {},
      });
    }
  }
  rememberedTabs = selectTabsForSync({
    previous: rememberedTabs,
    snapshot,
    settings,
    grantedOrigins: await getGrantedOrigins(),
    fallbackMaxRememberedTabs: MAX_REMEMBERED_TABS,
  });
  await saveState();
  return rememberedTabs;
}

async function captureFocusedPageContext(
  tabs: readonly RememberedTab[],
): Promise<CompanionSyncRequest["pageContexts"]> {
  const focused = findFocusedTab(tabs);
  if (!focused) {
    return [];
  }
  const tabId = parseNumericId(focused.tabId);
  if (tabId === null) {
    return [];
  }
  try {
    const response = await sendContentScriptMessage(tabId, {
      type: "browser-bridge:capture-page",
      expectedUrl: focused.url,
    });
    if (!response.ok || !response.page) {
      return [];
    }
    return [
      {
        browser: focused.browser,
        profileId: focused.profileId,
        windowId: focused.windowId,
        tabId: focused.tabId,
        url: response.page.url,
        title: response.page.title,
        selectionText: response.page.selectionText,
        mainText: response.page.mainText,
        headings: response.page.headings,
        links: response.page.links,
        forms: response.page.forms,
        capturedAt: response.page.capturedAt,
      },
    ];
  } catch {
    // error-policy:J4 Page capture failure omits that tab's optional context;
    // the tab remains visible and no synthetic page contents are emitted.
    return [];
  }
}

async function sendContentScriptMessage(
  tabId: number,
  message: unknown,
): Promise<ContentScriptResponse> {
  return await sendWithContentScriptRecovery({
    send: () => sendTabMessage<ContentScriptResponse>(tabId, message),
    inject: () => executeContentScriptFiles(tabId, ["content.js"]),
  });
}

async function buildSyncRequest(
  config: CompanionConfig,
  settings: BrowserBridgeSettings,
  settingsVersion: string,
): Promise<CompanionSyncRequest> {
  const tabs = await collectSnapshotTabs(config, settings);
  return {
    settingsVersion,
    companion: {
      browser: config.browser,
      profileId: config.profileId,
      profileLabel: config.profileLabel,
      label: config.label,
      extensionVersion: getManifestVersion(),
      connectionState: "connected",
      permissions: await describePermissionState(),
      lastSeenAt: new Date().toISOString(),
    },
    tabs,
    pageContexts: await captureFocusedPageContext(tabs),
  };
}

async function buildPreflightRequest(
  config: CompanionConfig,
): Promise<CompanionPreflightRequest> {
  return {
    companion: {
      browser: config.browser,
      profileId: config.profileId,
      profileLabel: config.profileLabel,
      label: config.label,
      extensionVersion: getManifestVersion(),
      connectionState: "connected",
      permissions: await describePermissionState(),
      lastSeenAt: new Date().toISOString(),
    },
  };
}

async function preflightAndSync(
  client: BrowserBridgeRelayClient,
  config: CompanionConfig,
) {
  const preflight = await client.preflight(await buildPreflightRequest(config));
  backgroundState.settings = preflight.settings;
  return await client.sync(
    await buildSyncRequest(
      config,
      preflight.settings,
      preflight.settingsVersion,
    ),
  );
}

async function runContentAction(
  tabId: number,
  expectedUrl: string,
  action: DomActionRequest,
): Promise<Record<string, unknown>> {
  const response = await sendContentScriptMessage(tabId, {
    type: "browser-bridge:execute-dom-action",
    expectedUrl,
    action,
  });
  if (response.ok === false) {
    throw new Error(response.error);
  }
  return response.actionResult ?? {};
}

async function executeAction(
  client: BrowserBridgeRelayClient,
  config: CompanionConfig,
  session: CompanionSession,
  action: BrowserBridgeAction,
  currentTabId: number | null,
  expectedActionIndex: number,
  attemptId: string,
): Promise<{ currentTabId: number | null; result: Record<string, unknown> }> {
  const freshSync = await preflightAndSync(client, config);
  backgroundState.settings = freshSync.settings;
  if (
    freshSync.session?.id !== session.id ||
    freshSync.session.currentActionIndex !== expectedActionIndex
  ) {
    throw new Error(
      "The browser session checkpoint changed before action execution.",
    );
  }
  const freshAction = freshSync.session.actions[expectedActionIndex];
  if (!freshAction || freshAction.id !== action.id) {
    throw new Error(
      "The browser session action changed before action execution.",
    );
  }
  const leasedSession = await client.beginSessionAction(session.id, {
    currentActionIndex: expectedActionIndex,
    actionId: freshAction.id,
    attemptId,
  });
  const executableAction = leasedSession.actions[expectedActionIndex];
  if (
    leasedSession.currentActionIndex !== expectedActionIndex ||
    !executableAction ||
    executableAction.id !== freshAction.id
  ) {
    throw new Error("The browser action lease does not match its checkpoint.");
  }
  const openTabs = await queryTabs({});
  const openWindows = await getAllWindows();
  const focusedTab =
    (await queryTabs({ active: true, lastFocusedWindow: true }))[0] ?? null;
  const target = resolveBrowserActionTarget({
    actionKind: executableAction.kind,
    actionTabId: executableAction.tabId,
    sessionTabId: session.tabId,
    currentTabId,
    actionWindowId: executableAction.windowId,
    sessionWindowId: session.windowId,
    tabs: openTabs,
    windows: openWindows,
    focusedTab,
  });
  const resolvedTabId = target.tabId;
  const existingTarget =
    resolvedTabId === null
      ? null
      : (openTabs.find((tab) => tab.id === resolvedTabId) ?? null);
  const targetUrl =
    executableAction.kind === "open" || executableAction.kind === "navigate"
      ? executableAction.url
      : existingTarget?.url;
  if (!targetUrl) {
    throw new Error(
      `${executableAction.kind} requires an authorized target URL`,
    );
  }
  const authorizationError = browserActionAuthorizationError({
    settings: freshSync.settings,
    target: {
      url: targetUrl,
      incognito: target.incognito,
      focusedActive: target.focusedActive,
    },
    grantedOrigins: await getGrantedOrigins(),
    currentFocusedUrl: focusedTab?.url ?? null,
  });
  if (authorizationError) {
    throw new Error(authorizationError);
  }
  switch (executableAction.kind) {
    case "open": {
      if (!executableAction.url) {
        throw new Error("open requires url");
      }
      const tab = await createTab({
        url: executableAction.url,
        active: true,
        ...(target.windowId === null ? {} : { windowId: target.windowId }),
      });
      return {
        currentTabId: typeof tab.id === "number" ? tab.id : null,
        result: {
          openedUrl: executableAction.url,
          tabId: tab.id ?? null,
          windowId: tab.windowId ?? null,
        },
      };
    }
    case "navigate": {
      if (!executableAction.url) {
        throw new Error("navigate requires url");
      }
      const tabId = resolvedTabId;
      if (tabId === null) {
        const tab = await createTab({
          url: executableAction.url,
          active: true,
          ...(target.windowId === null ? {} : { windowId: target.windowId }),
        });
        return {
          currentTabId: typeof tab.id === "number" ? tab.id : null,
          result: {
            navigatedUrl: executableAction.url,
            tabId: tab.id ?? null,
            createdTab: true,
          },
        };
      }
      const tab = await updateTab(tabId, {
        url: executableAction.url,
        active: true,
      });
      if (typeof tab.windowId === "number") {
        await focusWindow(tab.windowId);
      }
      return {
        currentTabId: tabId,
        result: {
          navigatedUrl: executableAction.url,
          tabId,
        },
      };
    }
    case "focus_tab": {
      const tabId = resolvedTabId;
      if (tabId === null) {
        throw new Error("focus_tab requires a target tab");
      }
      const tab = await updateTab(tabId, { active: true });
      if (typeof tab.windowId === "number") {
        await focusWindow(tab.windowId);
      }
      return {
        currentTabId: tabId,
        result: {
          focusedTabId: tabId,
        },
      };
    }
    case "reload": {
      const tabId = resolvedTabId;
      if (tabId === null) {
        throw new Error("reload requires a target tab");
      }
      await reloadTab(tabId);
      return {
        currentTabId: tabId,
        result: {
          reloadedTabId: tabId,
        },
      };
    }
    case "back": {
      const tabId = resolvedTabId;
      if (tabId === null) {
        throw new Error("back requires a target tab");
      }
      return {
        currentTabId: tabId,
        result: await runContentAction(tabId, targetUrl, {
          kind: "history_back",
        }),
      };
    }
    case "forward": {
      const tabId = resolvedTabId;
      if (tabId === null) {
        throw new Error("forward requires a target tab");
      }
      return {
        currentTabId: tabId,
        result: await runContentAction(tabId, targetUrl, {
          kind: "history_forward",
        }),
      };
    }
    case "click":
    case "type":
    case "submit": {
      const tabId = resolvedTabId;
      if (tabId === null) {
        throw new Error(`${executableAction.kind} requires a target tab`);
      }
      return {
        currentTabId: tabId,
        result: await runContentAction(tabId, targetUrl, {
          kind: executableAction.kind,
          selector: executableAction.selector ?? null,
          text: executableAction.text ?? null,
        }),
      };
    }
    case "read_page":
    case "extract_links":
    case "extract_forms": {
      const tabId = resolvedTabId;
      if (tabId === null) {
        throw new Error(`${executableAction.kind} requires a target tab`);
      }
      const response = await sendContentScriptMessage(tabId, {
        type: "browser-bridge:capture-page",
        expectedUrl: targetUrl,
      });
      if (response.ok === false || !response.page) {
        throw new Error(
          "error" in response ? response.error : "page capture failed",
        );
      }
      const result =
        executableAction.kind === "read_page"
          ? {
              title: response.page.title,
              url: response.page.url,
              selectionText: response.page.selectionText,
              mainText: response.page.mainText,
            }
          : executableAction.kind === "extract_links"
            ? { links: response.page.links }
            : { forms: response.page.forms };
      return {
        currentTabId: tabId,
        result,
      };
    }
    default:
      throw new Error(`Unsupported action kind ${executableAction.kind}`);
  }
}

async function executeSession(
  client: BrowserBridgeRelayClient,
  session: LifeOpsBrowserSession,
): Promise<void> {
  if (activeSessionId === session.id) {
    return;
  }
  activeSessionId = session.id;
  await setState({
    activeSessionId,
    lastSessionStatus: `running ${session.title}`,
    lastError: null,
  });

  const actionResults: Record<string, unknown> = {};
  let currentTabId = parseNumericId(session.tabId);
  const priorReceipt = session.metadata.browserActionReceipt;
  let completionActionId =
    priorReceipt &&
    typeof priorReceipt === "object" &&
    !Array.isArray(priorReceipt) &&
    typeof (priorReceipt as Record<string, unknown>).actionId === "string"
      ? ((priorReceipt as Record<string, unknown>).actionId as string)
      : null;
  let completionAttemptId =
    priorReceipt &&
    typeof priorReceipt === "object" &&
    !Array.isArray(priorReceipt) &&
    typeof (priorReceipt as Record<string, unknown>).attemptId === "string"
      ? ((priorReceipt as Record<string, unknown>).attemptId as string)
      : null;
  let activeAttempt: {
    actionId: string;
    actionIndex: number;
    attemptId: string;
  } | null = null;

  try {
    for (
      let index = session.currentActionIndex;
      index < session.actions.length;
      index += 1
    ) {
      const action = session.actions[index];
      const config = await readConfig();
      if (!config) {
        throw new Error("Browser companion configuration is unavailable.");
      }
      const attemptId = crypto.randomUUID();
      activeAttempt = {
        actionId: action.id,
        actionIndex: index,
        attemptId,
      };
      const outcome = await executeAction(
        client,
        config,
        session,
        action,
        currentTabId,
        index,
        attemptId,
      );
      currentTabId = outcome.currentTabId;
      actionResults[action.id] = outcome.result;
      await client.updateSessionProgress(session.id, {
        completedActionId: action.id,
        attemptId,
        currentActionIndex: index + 1,
        result: {
          [action.id]: outcome.result,
        },
        metadata: {
          lastActionId: action.id,
          lastActionKind: action.kind,
        },
      });
      completionActionId = action.id;
      completionAttemptId = attemptId;
      activeAttempt = null;
    }
    await client.completeSession(session.id, {
      status: "done",
      currentActionIndex: session.actions.length,
      completedActionId: completionActionId,
      attemptId: completionAttemptId,
      result: {
        actionResults,
      },
    });
    await setState({
      lastSessionStatus: `completed ${session.title}`,
    });
  } catch (error) {
    let conflict =
      (error instanceof RelayApiError && error.status === 409) ||
      activeAttempt === null;
    if (!conflict && activeAttempt) {
      try {
        // error-policy:J1 Session execution owns the terminal failure transition.
        await client.completeSession(session.id, {
          status: "failed",
          currentActionIndex: activeAttempt.actionIndex,
          completedActionId: activeAttempt.actionId,
          attemptId: activeAttempt.attemptId,
          result: {
            actionResults,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (completionError) {
        if (
          completionError instanceof RelayApiError &&
          completionError.status === 409
        ) {
          conflict = true;
        } else {
          throw completionError;
        }
      }
    }
    await setState({
      lastError: error instanceof Error ? error.message : String(error),
      lastSessionStatus: `${conflict ? "conflicted" : "failed"} ${session.title}`,
    });
  } finally {
    activeSessionId = null;
    await saveState();
  }
}

const BLOCKING_RULE_ID_OFFSET = 10_001;
const ALLOWLIST_RULE_ID_OFFSET = 20_001;

async function syncBlockingRules(apiBase: string): Promise<void> {
  const data = await withBrowserBridgeRequestTimeout(
    "Website blocker policy sync",
    async (signal) => {
      const resp = await fetch(`${apiBase}/api/website-blocker`, { signal });
      if (!resp.ok) {
        throw new Error(
          `website blocker sync failed: ${resp.status} ${resp.statusText}`,
        );
      }
      return (await resp.json()) as {
        active?: boolean;
        blockedWebsites?: string[];
        allowedWebsites?: string[];
        websites?: string[];
      };
    },
  );

  const existingRules = await getDynamicRules();
  const blockingRuleIds = existingRules
    .filter(
      (rule) =>
        rule.id >= BLOCKING_RULE_ID_OFFSET &&
        rule.id < BLOCKING_RULE_ID_OFFSET + 5_000,
    )
    .map((rule) => rule.id);
  const allowRuleIds = existingRules
    .filter(
      (rule) =>
        rule.id >= ALLOWLIST_RULE_ID_OFFSET &&
        rule.id < ALLOWLIST_RULE_ID_OFFSET + 5_000,
    )
    .map((rule) => rule.id);

  if (
    !data.active ||
    !Array.isArray(data.blockedWebsites ?? data.websites) ||
    (data.blockedWebsites ?? data.websites)?.length === 0
  ) {
    const ruleIdsToRemove = [...blockingRuleIds, ...allowRuleIds];
    if (ruleIdsToRemove.length > 0) {
      await updateDynamicRules({ removeRuleIds: ruleIdsToRemove });
    }
    return;
  }

  const extensionBlockedPage = getExtensionUrl("blocked.html");
  const blockedWebsites = (data.blockedWebsites ?? data.websites ?? []).filter(
    (website): website is string => typeof website === "string",
  );
  if (!(await hasAllUrlHostPermission())) {
    throw new Error(
      "Grant Website Access in the extension popup before enabling LifeOps website blocking.",
    );
  }
  const allowedWebsites = (data.allowedWebsites ?? []).filter(
    (website): website is string => typeof website === "string",
  );
  const blockedRules = blockedWebsites.map((host, index) => ({
    id: BLOCKING_RULE_ID_OFFSET + index,
    priority: 1,
    action: {
      type: "redirect" as const,
      redirect: {
        url: `${extensionBlockedPage}?host=${encodeURIComponent(host)}&url=${encodeURIComponent(`https://${host}`)}&api=${encodeURIComponent(apiBase)}`,
      },
    },
    condition: {
      urlFilter: `||${host}^`,
      resourceTypes: ["main_frame" as const],
    },
  }));
  const allowRules = allowedWebsites.map((host, index) => ({
    id: ALLOWLIST_RULE_ID_OFFSET + index,
    priority: 2,
    action: {
      type: "allow" as const,
    },
    condition: {
      urlFilter: `||${host}^`,
      resourceTypes: ["main_frame" as const],
    },
  }));

  await updateDynamicRules({
    removeRuleIds: [...blockingRuleIds, ...allowRuleIds],
    addRules: [...allowRules, ...blockedRules],
  });
}

function isCompanionTokenExpired(config: CompanionConfig): boolean {
  if (!config.pairingTokenExpiresAt) return false;
  const expiresAt = Date.parse(config.pairingTokenExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

async function enrollNativeCompanion(options: {
  bypassBackoff?: boolean;
}): Promise<CompanionConfig> {
  const profileId = await getOrCreateExtensionProfileId();
  const config = await nativeEnrollment.enroll(
    { browser: __BROWSER_BRIDGE_KIND__, profileId },
    { bypassBackoff: options.bypassBackoff },
  );
  const persisted = await persistCompanionConfig(config);
  if (!persisted) {
    throw new NativeEnrollmentError(
      "The native enrollment host returned an invalid companion config.",
      "invalid_native_response",
      false,
    );
  }
  backgroundState.config = persisted;
  return persisted;
}

async function ensureCompanionConfig(options: {
  bypassNativeBackoff?: boolean;
}): Promise<CompanionConfig> {
  const existing = await readConfig();
  if (existing && !isCompanionTokenExpired(existing)) return existing;
  if (existing) await clearCompanionConfig();
  return await enrollNativeCompanion({
    bypassBackoff: options.bypassNativeBackoff === true,
  });
}

async function performCompanionSync(config: CompanionConfig): Promise<void> {
  const client = new BrowserBridgeRelayClient(config);
  const response = await preflightAndSync(client, config);
  await setState({
    syncing: false,
    lastSyncAt: new Date().toISOString(),
    settings: response.settings,
    settingsSummary: `${response.settings.enabled ? response.settings.trackingMode : "off"} / control ${response.settings.allowBrowserControl ? "on" : "off"}`,
    connectionIssue: null,
    lastError: null,
    rememberedTabCount: response.tabs.length,
  });
  if (response.session) {
    await executeSession(client, response.session);
  }
  try {
    await syncBlockingRules(config.apiBaseUrl);
  } catch (error) {
    // error-policy:J4 Blocking-policy failure is shown in extension state
    // without fabricating successful rule synchronization.
    await setState({
      lastError: `website blocker sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

interface SyncRunRequest {
  reason: string;
  bypassNativeBackoff: boolean;
}

async function runSyncAttempt({
  reason,
  bypassNativeBackoff,
}: SyncRunRequest): Promise<BackgroundState> {
  await setState({
    syncing: true,
    lastError: null,
  });

  try {
    const config = await ensureCompanionConfig({ bypassNativeBackoff });
    await setState({ config });
    await performCompanionSync(config);
  } catch (error) {
    // error-policy:J1 The sync-loop boundary translates failures into durable
    // extension state and revokes invalid local pairing state.
    const isPairingInvalid = isCompanionAuthError(error);
    const isExpired =
      isPairingInvalid &&
      error.code === "browser_bridge_companion_token_expired";
    const isRevoked =
      isPairingInvalid &&
      error.code === "browser_bridge_companion_token_revoked";
    let finalError = error;
    if (isExpired) {
      await clearCompanionConfig();
      try {
        const renewed = await enrollNativeCompanion({
          bypassBackoff: true,
        });
        await setState({ config: renewed });
        await performCompanionSync(renewed);
        return backgroundState;
      } catch (renewalError) {
        finalError = renewalError;
      }
    } else if (isPairingInvalid) {
      await clearCompanionConfig();
      await suppressNativeEnrollment(
        isRevoked ? "companion_revoked" : "credential_invalid",
      );
    }
    const finalPairingError = isCompanionAuthError(finalError)
      ? finalError
      : null;
    const nativeEnrollmentFailure = finalError instanceof NativeEnrollmentError;
    const connectionIssue =
      finalError instanceof NativeEnrollmentError &&
      (finalError.code === "app_not_running" ||
        finalError.code === "app_not_authenticated")
        ? finalError.code
        : null;
    await setState({
      syncing: false,
      ...((isPairingInvalid ||
        finalPairingError !== null ||
        nativeEnrollmentFailure) && {
        config: null,
        settingsSummary: null,
      }),
      lastError: finalPairingError
        ? companionAuthErrorMessage(finalPairingError)
        : `${reason}: ${finalError instanceof Error ? finalError.message : String(finalError)}`,
      connectionIssue,
    });
  }
  return backgroundState;
}

const syncRunner = new CoalescingSyncRunner<SyncRunRequest, BackgroundState>(
  (current, next) => ({
    reason: current === null ? next.reason : "queued",
    bypassNativeBackoff:
      (current?.bypassNativeBackoff ?? false) || next.bypassNativeBackoff,
  }),
  runSyncAttempt,
);

async function syncNow(
  reason: string,
  options: { bypassNativeBackoff?: boolean } = {},
): Promise<BackgroundState> {
  return await syncRunner.request({
    reason,
    bypassNativeBackoff: options.bypassNativeBackoff === true,
  });
}

function scheduleSync(reason: string): void {
  if (syncDebounceScheduled) {
    return;
  }
  syncDebounceScheduled = true;
  setTimeout(() => {
    syncDebounceScheduled = false;
    void syncNow(reason);
  }, SYNC_DEBOUNCE_MS);
}

async function handlePopupMessage(
  message: PopupRequest,
): Promise<PopupResponse> {
  try {
    switch (message.type) {
      case "browser-bridge:get-state": {
        const config = await readConfig();
        const persistedState = await loadBackgroundState();
        backgroundState = persistedState ?? backgroundState;
        backgroundState.config = config;
        return { ok: true, state: backgroundState };
      }
      case "browser-bridge:auto-pair": {
        await setState({
          lastError:
            "Automatic pairing is disabled. Create an authenticated pairing in Eliza and import its pairing JSON.",
        });
        return { ok: true, state: backgroundState };
      }
      case "browser-bridge:save-config": {
        if (
          typeof message.config?.apiBaseUrl === "string" &&
          message.config.apiBaseUrl.trim().length > 0 &&
          !isValidApiBaseUrl(message.config.apiBaseUrl)
        ) {
          throw new Error("apiBaseUrl must be an http:// or https:// URL");
        }
        const nextConfig = normalizeCompanionConfig({
          ...(await readConfig()),
          ...(message.config ?? {}),
          browser: __BROWSER_BRIDGE_KIND__,
        });
        if (!nextConfig) {
          throw new Error("companionId and pairingToken are required");
        }
        await resetNativeEnrollmentState();
        await saveCompanionConfig(nextConfig);
        await setState({
          config: nextConfig,
          settings: backgroundState.settings,
          lastError: null,
          connectionIssue: null,
        });
        createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
        scheduleSync("config");
        return { ok: true, state: backgroundState };
      }
      case "browser-bridge:clear-config": {
        await clearCompanionConfig();
        await suppressNativeEnrollment("owner_disconnected");
        rememberedTabs = [];
        activeSessionId = null;
        await setState({
          config: null,
          settings: null,
          lastError: "Agent Browser Bridge companion pairing cleared.",
          lastSessionStatus: null,
          lastSyncAt: null,
          rememberedTabCount: 0,
          settingsSummary: null,
          connectionIssue: null,
        });
        return { ok: true, state: backgroundState };
      }
      case "browser-bridge:sync-now": {
        return {
          ok: true,
          state: await syncNow("popup"),
        };
      }
      case "browser-bridge:owner-reconnect": {
        await resumeNativeEnrollmentAfterOwnerDisconnect();
        return {
          ok: true,
          state: await syncNow("owner-reconnect", {
            bypassNativeBackoff: true,
          }),
        };
      }
      default:
        throw new Error("Unsupported popup request");
    }
  } catch (error) {
    // error-policy:J1 Popup requests return a structured failure response.
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      state: backgroundState,
    };
  }
}

addRuntimeMessageListener((message, sender, sendResponse) => {
  // This channel writes the pairing credential (`browser-bridge:save-config`),
  // so it accepts messages only from the extension's own privileged contexts.
  // Content scripts share `runtime.onMessage`, and ours run on every localhost
  // port.
  if (!isPrivilegedExtensionSender(sender)) {
    return false;
  }
  const request = message as PopupRequest | undefined;
  if (!request || typeof request !== "object" || !("type" in request)) {
    return false;
  }
  void handlePopupMessage(request).then((response) => {
    sendResponse(response);
  });
  return true;
});

addInstalledListener(() => {
  createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
  scheduleSync("install");
});

addStartupListener(() => {
  createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
  scheduleSync("startup");
});

addAlarmListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void syncNow("alarm");
  }
});

addTabsActivatedListener(() => {
  scheduleSync("tab-activated");
});

addTabsUpdatedListener((_tabId, changeInfo) => {
  const record = changeInfo as {
    status?: string;
    url?: string;
    title?: string;
  };
  if (record.status === "complete" || record.url || record.title) {
    scheduleSync("tab-updated");
  }
});

addTabsRemovedListener(() => {
  scheduleSync("tab-removed");
});

addWindowFocusListener(() => {
  scheduleSync("window-focus");
});

void (async () => {
  const persistedState = await loadBackgroundState();
  if (persistedState) {
    backgroundState = persistedState;
  }
  createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
  scheduleSync("startup-bootstrap");
})();
