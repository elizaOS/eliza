import type {
  BrowserBridgeAction,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";
import type { LifeOpsBrowserSession } from "@elizaos/shared/contracts/lifeops";
import { BrowserBridgeRelayClient, RelayApiError } from "../src/api-client";
import type {
  BackgroundState,
  CompanionAutoPairRequest,
  CompanionAutoPairResponse,
  CompanionConfig,
  CompanionSession,
  CompanionSyncRequest,
  ContentScriptResponse,
  PopupRequest,
  PopupResponse,
} from "../src/protocol";
import {
  candidateApiBaseUrlsFromTabs,
  clearCompanionConfig,
  discoverReachableAgentApiBaseUrls,
  isValidApiBaseUrl,
  loadBackgroundState,
  loadCompanionConfig,
  normalizeCompanionConfig,
  saveBackgroundState,
  saveCompanionConfig,
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
  executeScriptInMainWorld,
  focusWindow,
  getAllWindows,
  getDynamicRules,
  getExtensionUrl,
  getGrantedOrigins,
  getManifestVersion,
  hasAllUrlHostPermission,
  hasManifestPermission,
  isIncognitoAccessAllowed,
  queryTabs,
  reloadTab,
  sendTabMessage,
  updateDynamicRules,
  updateTab,
} from "../src/webextension";

declare const __BROWSER_BRIDGE_KIND__: "chrome" | "safari";

const SYNC_ALARM = "browser-bridge-sync";
const SYNC_INTERVAL_MINUTES = 0.5;
const SYNC_DEBOUNCE_MS = 750;
const MAX_REMEMBERED_TABS = 10;
const AUTO_PAIR_COOLDOWN_MS = 30_000;
const AUTO_PAIR_ROUTE = "/api/browser-bridge/companions/auto-pair";

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
};
let rememberedTabs: RememberedTab[] = [];
let syncScheduled = false;
let syncInFlight = false;
let activeSessionId: string | null = null;
let autoPairInFlight = false;
let lastAutoPairAttemptAt = 0;

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

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function tabsForApiBaseUrl(
  tabs: readonly { id?: number; url?: string }[],
  apiBaseUrl: string,
): number[] {
  const origin = normalizeOrigin(apiBaseUrl);
  if (!origin) {
    return [];
  }
  return tabs
    .map((tab) => ({
      tabId: typeof tab.id === "number" ? tab.id : null,
      origin: normalizeOrigin(tab.url),
    }))
    .filter(
      (candidate): candidate is { tabId: number; origin: string } =>
        candidate.tabId !== null && candidate.origin === origin,
    )
    .map((candidate) => candidate.tabId);
}

function buildAutoPairRequest(
  config: CompanionConfig | null,
): CompanionAutoPairRequest {
  return {
    browser: __BROWSER_BRIDGE_KIND__,
    profileId: config?.profileId ?? "default",
    profileLabel: config?.profileLabel ?? "Default",
    label: config?.label ?? "",
    extensionVersion: getManifestVersion(),
  };
}

function autoPairErrorMessage(
  apiBaseUrl: string,
  status: number | null,
  error: string,
): string {
  if (status === 401 || status === 403) {
    return `Open ${apiBaseUrl} while logged in, then reopen the Agent Browser Bridge popup to auto-pair.`;
  }
  if (status === 404) {
    return `${apiBaseUrl} does not expose browser-bridge auto-pair yet.`;
  }
  return error;
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
    return "Pairing was revoked. Agent Browser Bridge will try to auto-pair again.";
  }
  if (error.code === "browser_bridge_companion_token_expired") {
    return "Pairing expired. Agent Browser Bridge will try to auto-pair again.";
  }
  return "Pairing is no longer valid. Agent Browser Bridge will try to auto-pair again.";
}

function readAutoPairResponsePayload(
  payload: unknown,
): CompanionAutoPairResponse | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as {
    companion?: unknown;
    config?: Partial<CompanionConfig>;
  };
  if (!record.companion || typeof record.companion !== "object") {
    return null;
  }
  const config = normalizeCompanionConfig(record.config);
  if (!config) {
    return null;
  }
  return {
    companion: record.companion as CompanionAutoPairResponse["companion"],
    config,
  };
}

async function requestAutoPairFromBackground(
  apiBaseUrl: string,
  request: CompanionAutoPairRequest,
): Promise<
  | { ok: true; data: CompanionAutoPairResponse }
  | { ok: false; status: number | null; error: string }
> {
  try {
    const response = await fetch(`${apiBaseUrl}${AUTO_PAIR_ROUTE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(request),
    });
    const payload = (await response.json().catch(() => null)) as
      | CompanionAutoPairResponse
      | { error?: string; message?: string }
      | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error:
          (payload &&
            typeof payload === "object" &&
            (payload.error ?? payload.message)) ||
          `${response.status} ${response.statusText}`,
      };
    }
    const data = readAutoPairResponsePayload(payload);
    if (!data) {
      return {
        ok: false,
        status: response.status,
        error: "Auto-pair returned an invalid companion config.",
      };
    }
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requestAutoPairFromTab(
  tabId: number,
  apiBaseUrl: string,
  request: CompanionAutoPairRequest,
): Promise<
  | { ok: true; data: CompanionAutoPairResponse }
  | { ok: false; status: number | null; error: string }
> {
  try {
    const result = await executeScriptInMainWorld<{
      ok: boolean;
      status: number | null;
      error?: string;
      data?: CompanionAutoPairResponse;
    }>(
      tabId,
      async (baseUrl, payload) => {
        try {
          const response = await fetch(
            `${String(baseUrl)}/api/browser-bridge/companions/auto-pair`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              credentials: "include",
              body: JSON.stringify(payload),
            },
          );
          const data = (await response.json().catch(() => null)) as
            | CompanionAutoPairResponse
            | { error?: string; message?: string }
            | null;
          if (!response.ok) {
            return {
              ok: false,
              status: response.status,
              error:
                (data &&
                  typeof data === "object" &&
                  (data.error ?? data.message)) ||
                `${response.status} ${response.statusText}`,
            };
          }
          return {
            ok: true,
            status: response.status,
            data: data as CompanionAutoPairResponse,
          };
        } catch (error) {
          return {
            ok: false,
            status: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      [apiBaseUrl, request],
    );
    if (result.ok && result.data) {
      const data = readAutoPairResponsePayload(result.data);
      if (!data) {
        return {
          ok: false,
          status: result.status,
          error: "Auto-pair returned an invalid companion config.",
        };
      }
      return {
        ok: true,
        data,
      };
    }
    return {
      ok: false,
      status: result.status,
      error: result.error ?? "Auto-pair failed in the Eliza tab.",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function attemptAutoPair(
  reason: string,
): Promise<CompanionConfig | null> {
  if (autoPairInFlight) {
    return null;
  }
  const now = Date.now();
  if (now - lastAutoPairAttemptAt < AUTO_PAIR_COOLDOWN_MS) {
    return null;
  }
  lastAutoPairAttemptAt = now;
  autoPairInFlight = true;

  try {
    const existingConfig = await loadCompanionConfig();
    const request = buildAutoPairRequest(existingConfig);
    const openTabs = await queryTabs({});
    const candidateApiBaseUrls = [
      ...new Set([
        ...candidateApiBaseUrlsFromTabs(openTabs),
        ...(await discoverReachableAgentApiBaseUrls()),
      ]),
    ];
    let lastErrorMessage =
      "Open Eliza in this browser, then reopen the popup to auto-pair.";

    for (const apiBaseUrl of candidateApiBaseUrls) {
      for (const tabId of tabsForApiBaseUrl(openTabs, apiBaseUrl)) {
        const response = await requestAutoPairFromTab(
          tabId,
          apiBaseUrl,
          request,
        );
        if (response.ok) {
          const config = await saveCompanionConfig(response.data.config);
          if (config) {
            createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
            await setState({
              config,
              lastError: null,
              lastSessionStatus: `Auto-paired with ${apiBaseUrl}`,
            });
            return config;
          }
        }
        lastErrorMessage = autoPairErrorMessage(
          apiBaseUrl,
          response.status,
          response.error,
        );
      }

      const response = await requestAutoPairFromBackground(apiBaseUrl, request);
      if (response.ok) {
        const config = await saveCompanionConfig(response.data.config);
        if (config) {
          createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
          await setState({
            config,
            lastError: null,
            lastSessionStatus: `Auto-paired with ${apiBaseUrl}`,
          });
          return config;
        }
      }
      lastErrorMessage = autoPairErrorMessage(
        apiBaseUrl,
        response.status,
        response.error,
      );
    }

    await setState({
      lastError:
        reason === "popup"
          ? lastErrorMessage
          : (backgroundState.lastError ?? lastErrorMessage),
    });
    return null;
  } finally {
    autoPairInFlight = false;
  }
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
    const response = await sendTabMessage<ContentScriptResponse>(tabId, {
      type: "browser-bridge:capture-page",
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
    return [];
  }
}

async function buildSyncRequest(
  config: CompanionConfig,
): Promise<CompanionSyncRequest> {
  const settings = backgroundState.settings;
  const tabs = await collectSnapshotTabs(config, settings);
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
    tabs,
    pageContexts: await captureFocusedPageContext(tabs),
  };
}

async function resolveTargetTab(
  action: BrowserBridgeAction,
  session: CompanionSession,
  currentTabId: number | null,
): Promise<number | null> {
  const explicitTabId =
    parseNumericId(action.tabId) ??
    parseNumericId(session.tabId) ??
    currentTabId;
  if (explicitTabId !== null) {
    return explicitTabId;
  }
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  return typeof activeTabs[0]?.id === "number" ? activeTabs[0].id : null;
}

async function runContentAction(
  tabId: number,
  action: {
    kind: "click" | "type" | "submit" | "history_back" | "history_forward";
    selector?: string | null;
    text?: string | null;
  },
): Promise<Record<string, unknown>> {
  const response = await sendTabMessage<ContentScriptResponse>(tabId, {
    type: "browser-bridge:execute-dom-action",
    action,
  });
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.actionResult ?? {};
}

async function executeAction(
  session: CompanionSession,
  action: BrowserBridgeAction,
  currentTabId: number | null,
): Promise<{ currentTabId: number | null; result: Record<string, unknown> }> {
  switch (action.kind) {
    case "open": {
      if (!action.url) {
        throw new Error("open requires url");
      }
      const tab = await createTab({ url: action.url, active: true });
      return {
        currentTabId: typeof tab.id === "number" ? tab.id : null,
        result: {
          openedUrl: action.url,
          tabId: tab.id ?? null,
          windowId: tab.windowId ?? null,
        },
      };
    }
    case "navigate": {
      if (!action.url) {
        throw new Error("navigate requires url");
      }
      const tabId = await resolveTargetTab(action, session, currentTabId);
      if (tabId === null) {
        const tab = await createTab({ url: action.url, active: true });
        return {
          currentTabId: typeof tab.id === "number" ? tab.id : null,
          result: {
            navigatedUrl: action.url,
            tabId: tab.id ?? null,
            createdTab: true,
          },
        };
      }
      const tab = await updateTab(tabId, { url: action.url, active: true });
      if (typeof tab.windowId === "number") {
        await focusWindow(tab.windowId);
      }
      return {
        currentTabId: tabId,
        result: {
          navigatedUrl: action.url,
          tabId,
        },
      };
    }
    case "focus_tab": {
      const tabId = await resolveTargetTab(action, session, currentTabId);
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
      const tabId = await resolveTargetTab(action, session, currentTabId);
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
      const tabId = await resolveTargetTab(action, session, currentTabId);
      if (tabId === null) {
        throw new Error("back requires a target tab");
      }
      return {
        currentTabId: tabId,
        result: await runContentAction(tabId, { kind: "history_back" }),
      };
    }
    case "forward": {
      const tabId = await resolveTargetTab(action, session, currentTabId);
      if (tabId === null) {
        throw new Error("forward requires a target tab");
      }
      return {
        currentTabId: tabId,
        result: await runContentAction(tabId, { kind: "history_forward" }),
      };
    }
    case "click":
    case "type":
    case "submit": {
      const tabId = await resolveTargetTab(action, session, currentTabId);
      if (tabId === null) {
        throw new Error(`${action.kind} requires a target tab`);
      }
      return {
        currentTabId: tabId,
        result: await runContentAction(tabId, {
          kind: action.kind,
          selector: action.selector ?? null,
          text: action.text ?? null,
        }),
      };
    }
    case "read_page":
    case "extract_links":
    case "extract_forms": {
      const tabId = await resolveTargetTab(action, session, currentTabId);
      if (tabId === null) {
        throw new Error(`${action.kind} requires a target tab`);
      }
      const response = await sendTabMessage<ContentScriptResponse>(tabId, {
        type: "browser-bridge:capture-page",
      });
      if (!response.ok || !response.page) {
        throw new Error(response.ok ? "page capture failed" : response.error);
      }
      const result =
        action.kind === "read_page"
          ? {
              title: response.page.title,
              url: response.page.url,
              selectionText: response.page.selectionText,
              mainText: response.page.mainText,
            }
          : action.kind === "extract_links"
            ? { links: response.page.links }
            : { forms: response.page.forms };
      return {
        currentTabId: tabId,
        result,
      };
    }
    default:
      throw new Error(`Unsupported action kind ${action.kind}`);
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

  try {
    for (
      let index = session.currentActionIndex;
      index < session.actions.length;
      index += 1
    ) {
      const action = session.actions[index];
      const outcome = await executeAction(session, action, currentTabId);
      currentTabId = outcome.currentTabId;
      actionResults[action.id] = outcome.result;
      await client.updateSessionProgress(session.id, {
        currentActionIndex: index + 1,
        result: {
          [action.id]: outcome.result,
        },
        metadata: {
          lastActionId: action.id,
          lastActionKind: action.kind,
        },
      });
    }
    await client.completeSession(session.id, {
      status: "done",
      result: {
        actionResults,
      },
    });
    await setState({
      lastSessionStatus: `completed ${session.title}`,
    });
  } catch (error) {
    await client.completeSession(session.id, {
      status: "failed",
      result: {
        actionResults,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    await setState({
      lastError: error instanceof Error ? error.message : String(error),
      lastSessionStatus: `failed ${session.title}`,
    });
  } finally {
    activeSessionId = null;
    await saveState();
  }
}

/**
 * Max number of declarativeNetRequest dynamic rules to use for blocking.
 * Chrome allows up to 5000 dynamic rules; we use a safe subset starting
 * at ID offset 10001 to avoid collisions with other rule uses.
 */
const BLOCKING_RULE_ID_OFFSET = 10_001;
const ALLOWLIST_RULE_ID_OFFSET = 20_001;

async function syncBlockingRules(apiBase: string): Promise<void> {
  const resp = await fetch(`${apiBase}/api/website-blocker`);
  if (!resp.ok) {
    throw new Error(
      `website blocker sync failed: ${resp.status} ${resp.statusText}`,
    );
  }
  const data = (await resp.json()) as {
    active?: boolean;
    blockedWebsites?: string[];
    allowedWebsites?: string[];
    websites?: string[];
  };

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

async function syncNow(reason: string): Promise<BackgroundState> {
  let config = await readConfig();
  if (!config) {
    config = await attemptAutoPair(reason);
  }
  if (!config) {
    await setState({
      syncing: false,
      lastError:
        backgroundState.lastError ??
        "Agent Browser Bridge companion is not paired.",
      settingsSummary: null,
      lastSessionStatus: null,
    });
    return backgroundState;
  }
  if (syncInFlight) {
    syncScheduled = true;
    return backgroundState;
  }
  syncInFlight = true;
  await setState({
    syncing: true,
    config,
    lastError: null,
  });

  try {
    const client = new BrowserBridgeRelayClient(config);
    const request = await buildSyncRequest(config);
    const response = await client.sync(request);
    await setState({
      syncing: false,
      lastSyncAt: new Date().toISOString(),
      settings: response.settings,
      settingsSummary: `${response.settings.enabled ? response.settings.trackingMode : "off"} / control ${response.settings.allowBrowserControl ? "on" : "off"}`,
      lastError: null,
      rememberedTabCount: response.tabs.length,
    });
    if (response.session) {
      void executeSession(client, response.session).catch((error) => {
        void setState({
          lastError: `session execution failed: ${error instanceof Error ? error.message : String(error)}`,
          lastSessionStatus: `failed ${response.session?.title ?? "browser session"}`,
        }).catch(() => undefined);
      });
    }
    try {
      await syncBlockingRules(config.apiBaseUrl);
    } catch (error) {
      await setState({
        lastError: `website blocker sync failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } catch (error) {
    const isPairingInvalid = isCompanionAuthError(error);
    if (isPairingInvalid) {
      syncScheduled = false;
      await clearCompanionConfig();
    }
    await setState({
      syncing: false,
      ...(isPairingInvalid && { config: null, settingsSummary: null }),
      lastError: isPairingInvalid
        ? companionAuthErrorMessage(error)
        : `${reason}: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    syncInFlight = false;
    if (syncScheduled) {
      syncScheduled = false;
      setTimeout(() => {
        void syncNow("queued");
      }, SYNC_DEBOUNCE_MS);
    }
  }
  return backgroundState;
}

function scheduleSync(reason: string): void {
  if (syncScheduled) {
    return;
  }
  syncScheduled = true;
  setTimeout(() => {
    syncScheduled = false;
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
        await attemptAutoPair("popup");
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
        await saveCompanionConfig(nextConfig);
        await setState({
          config: nextConfig,
          settings: backgroundState.settings,
          lastError: null,
        });
        createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
        scheduleSync("config");
        return { ok: true, state: backgroundState };
      }
      case "browser-bridge:clear-config": {
        await clearCompanionConfig();
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
        });
        return { ok: true, state: backgroundState };
      }
      case "browser-bridge:sync-now": {
        return { ok: true, state: await syncNow("popup") };
      }
      default:
        throw new Error("Unsupported popup request");
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      state: backgroundState,
    };
  }
}

addRuntimeMessageListener((message, _sender, sendResponse) => {
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
  await readConfig();
  createAlarm(SYNC_ALARM, SYNC_INTERVAL_MINUTES);
  scheduleSync("startup-bootstrap");
})();
