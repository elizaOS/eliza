/** Installed-native smoke drivers. Loaded only by the native shell; every driver requires a harness request marker. */
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import {
  client,
  FIRST_RUN_CLOUD_LOGIN_ACTION,
  logger,
  shellLocalStorage,
  tryHandleFirstRunAction,
} from "@elizaos/ui";
import { runIosAttachmentSmokeIfRequested } from "./ios-attachment-smoke";
import {
  extractIosLivenessChallengeToken,
  isIosCloudOnboardingComplete,
  isIosLivenessReplyRow,
  parseIosCloudOnboardingSmokeRequest,
} from "./ios-cloud-onboarding-smoke";

const isIOS = Capacitor.getPlatform() === "ios";
const isNative = Capacitor.isNativePlatform();
const IOS_ONBOARDING_SMOKE_REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const IOS_ONBOARDING_SMOKE_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY =
  "eliza:ios-cloud-onboarding-smoke:request";
const IOS_CLOUD_ONBOARDING_SMOKE_RESULT_KEY =
  "eliza:ios-cloud-onboarding-smoke:result";
const IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY = "eliza:auth-callback-smoke:request";
const IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY = "eliza:auth-callback-smoke:result";
const IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY =
  "eliza:ios-onboarding-relaunch-smoke:request";
const IOS_ONBOARDING_RELAUNCH_SMOKE_RESULT_KEY =
  "eliza:ios-onboarding-relaunch-smoke:result";
const IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY =
  "eliza:ios-mixed-content-smoke:request";
const IOS_MIXED_CONTENT_SMOKE_RESULT_KEY =
  "eliza:ios-mixed-content-smoke:result";
const IOS_ONBOARDING_SMOKE_TIMEOUT_MS = 120_000;
let iosOnboardingSmokeStarted = false;
let iosCloudOnboardingSmokeStarted = false;
let iosOnboardingRelaunchSmokeStarted = false;
let iosMixedContentSmokeStarted = false;

async function writeIosOnboardingSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(IOS_ONBOARDING_SMOKE_RESULT_KEY, result);
}

async function writeIosCloudOnboardingSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_CLOUD_ONBOARDING_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosOnboardingRelaunchSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_ONBOARDING_RELAUNCH_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosMixedContentSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_MIXED_CONTENT_SMOKE_RESULT_KEY,
    result,
  );
}

export async function writeIosAuthCallbackSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY,
    result,
  );
}

export interface AuthCallbackDeepLinkOutcome {
  accepted: boolean;
  classification: "synthetic_callback_rejected";
  reason: string;
}

async function writeIosPreferenceSmokeResult(
  key: string,
  result: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify({
    ...result,
    updatedAt: new Date().toISOString(),
  });
  try {
    // shellLocalStorage, not Storage.prototype.call: the surface-realm guard
    // Proxy does not forward Storage internal slots, so a prototype-bound call
    // throws "Illegal invocation" once any view has mounted.
    shellLocalStorage.setItem(key, value);
  } catch {
    // error-policy:J6 best-effort echo — Preferences is the simulator
    // harness source of truth
  }
  await boundedPreferenceWrite(() =>
    Preferences.set({
      key,
      value,
    }),
  );
}

async function boundedPreferenceWrite(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await Promise.race([
      operation(),
      new Promise((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
  } catch {
    // error-policy:J7 smoke-harness diagnostics write — the storage bridge
    // also issued a fire-and-forget Preferences write from
    // localStorage.setItem. The simulator smoke will keep polling the native
    // defaults domain, but the WebView must not block forever on persistence.
  }
}

async function boundedPreferenceGet(key: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      Preferences.get({ key }),
      new Promise<null>((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
    return result?.value ?? null;
  } catch {
    // error-policy:J7 smoke-harness preference probe — a blocked Preferences
    // bridge must not wedge the smoke; the poll loop retries
    return null;
  }
}

function parseIosOnboardingSmokeRequest(raw: string | null): {
  apiBase: string;
  // Liveness contract (#14359): when the harness points the lane at a
  // live-provider host it sets `liveness: true` so the verifier drives one real
  // chat turn after landing on home and reports the reply for the shared
  // non-stub assertion. Default false — the deterministic host is stub-backed.
  liveness: boolean;
  livenessPrompt: string;
} {
  const fallback = {
    apiBase: "http://127.0.0.1:31338",
    liveness: false,
    livenessPrompt: "In one short sentence, say hello.",
  };
  if (!raw || raw === "1") return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      apiBase?: unknown;
      liveness?: unknown;
      livenessPrompt?: unknown;
    };
    return {
      apiBase:
        typeof parsed.apiBase === "string" && parsed.apiBase.trim()
          ? parsed.apiBase.trim()
          : fallback.apiBase,
      liveness: parsed.liveness === true,
      livenessPrompt:
        typeof parsed.livenessPrompt === "string" &&
        parsed.livenessPrompt.trim()
          ? parsed.livenessPrompt.trim()
          : fallback.livenessPrompt,
    };
  } catch {
    // error-policy:J3 corrupt smoke-request blob — run with the defaults
    return fallback;
  }
}

async function readIosMixedContentSmokeRequest(
  fallbackApiBase?: string,
): Promise<{ apiBase: string } | null> {
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest && !fallbackApiBase) return null;
  return parseIosOnboardingSmokeRequest(
    rawRequest ?? JSON.stringify({ apiBase: fallbackApiBase }),
  );
}

async function waitForIosOnboardingElement<T extends Element>(
  selector: string,
  options?: { timeoutMs?: number; visible?: boolean },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastElement: Element | null = null;
  while (Date.now() < deadline) {
    lastElement = document.querySelector(selector);
    if (lastElement) {
      const visible =
        !options?.visible ||
        (lastElement instanceof HTMLElement &&
          lastElement.offsetParent !== null);
      if (visible) return lastElement as T;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for iOS onboarding selector ${selector}${lastElement ? " to become visible" : ""}`,
  );
}

function readIosOnboardingSmokeStorageSnapshot(): Record<
  string,
  string | null
> {
  const keys = [
    "eliza:first-run-complete",
    "eliza:setup:step",
    "eliza:mobile-runtime-mode",
    "elizaos:active-server",
  ];
  return Object.fromEntries(
    keys.map((key) => {
      try {
        return [key, window.localStorage.getItem(key)];
      } catch {
        // error-policy:J7 diagnostics snapshot — an unreadable key reports null
        return [key, null];
      }
    }),
  );
}

function readIosCloudOnboardingSmokeStorageSnapshot(): Record<
  string,
  string | boolean | null
> {
  const base = readIosOnboardingSmokeStorageSnapshot();
  let stewardSessionToken = "";
  try {
    stewardSessionToken =
      window.localStorage.getItem("steward_session_token") ?? "";
  } catch {
    // error-policy:J7 diagnostics snapshot — an unreadable key reports false
    stewardSessionToken = "";
  }
  return {
    ...base,
    stewardSessionPresent: stewardSessionToken.length > 0,
  };
}

async function waitForIosOnboardingSmokeStorageSnapshot(
  apiBase: string,
): Promise<Record<string, string | null>> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  let snapshot = readIosOnboardingSmokeStorageSnapshot();
  while (Date.now() < deadline) {
    const activeServer = snapshot["elizaos:active-server"];
    if (typeof activeServer === "string" && activeServer.includes(apiBase)) {
      return snapshot;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    snapshot = readIosOnboardingSmokeStorageSnapshot();
  }
  throw new Error(
    `Timed out waiting for iOS onboarding active server ${apiBase}: ${JSON.stringify(snapshot)}`,
  );
}

const IOS_LIVENESS_ASSISTANT_SELECTOR =
  '[data-role="assistant"], [data-testid="chat-message-assistant"], [data-testid="thread-line"][data-role="assistant"]';

// Set a React-controlled textarea's value so React's onChange fires. Assigning
// `.value` directly bypasses React's synthetic value tracker, so we call the
// native prototype setter first, then dispatch a bubbling `input` event — the
// canonical way to drive a controlled input from outside React.
function setReactTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!setter) {
    throw new Error("HTMLTextAreaElement value setter unavailable");
  }
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Drive one real chat turn in-app and return the rendered assistant reply, so
 * the harness can enforce the shared liveness contract (#14359) against a
 * live-provider host. The SIWE cloud lane always drives it (#16936); the
 * remote-connect lane still opts in with `liveness: true`, because that lane
 * also runs against the deterministic stub host.
 *
 * Fail-closed reply selection (#16936 review): only assistant rows that did
 * not exist before the send are considered, and — when the prompt carries a
 * run-unique challenge token — a row counts only once its text contains that
 * token. The pending overlay row renders a status label ("Thinking") as its
 * text content before any model token arrives; reading any non-empty new row
 * would accept that placeholder, so the token requirement is what proves a
 * real model answered this exact turn. A tokenless prompt (the remote-connect
 * default hello) falls back to requiring a reply-phase body on the new row,
 * which the pending row can never satisfy because the renderer marks it
 * `data-phase="status"` until real content exists.
 */
async function driveIosLivenessChatTurn(prompt: string): Promise<string> {
  const composer = await waitForIosOnboardingElement<HTMLTextAreaElement>(
    '[data-testid="chat-composer-textarea"]',
    { visible: true },
  );
  const priorReplies = document.querySelectorAll(
    IOS_LIVENESS_ASSISTANT_SELECTOR,
  ).length;
  const expectedToken = extractIosLivenessChallengeToken(prompt);

  composer.focus();
  setReactTextareaValue(composer, prompt);
  const send = document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]',
  );
  if (send && !send.disabled) {
    send.click();
  } else {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  }

  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  // Invariant: the overlay transcript only appends rows during a turn, so
  // indices at or beyond the pre-send snapshot are exactly this run's rows.
  while (Date.now() < deadline) {
    const replies = document.querySelectorAll<HTMLElement>(
      IOS_LIVENESS_ASSISTANT_SELECTOR,
    );
    for (let index = priorReplies; index < replies.length; index += 1) {
      const row = replies[index];
      // A pending row (status phase) can never be the reply — its text is the
      // "Thinking"/"Running …" placeholder. This also blocks status chrome
      // that echoes the prompt text from satisfying the token gate.
      if (!isIosLivenessReplyRow(row)) continue;
      const text = row?.textContent?.trim() ?? "";
      if (!text) continue;
      if (expectedToken) {
        // The run-unique token can only appear in text produced by something
        // that saw this run's prompt — never in a status label or cached row.
        if (text.toLowerCase().includes(expectedToken)) return text;
      } else {
        return text;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(
    "iOS liveness chat turn: assistant never produced a reply within the timeout",
  );
}

function installFirstRunPostCounter(): {
  getCount: () => number;
  restore: () => void;
} {
  const originalFetch = window.fetch.bind(window);
  let firstRunPostCount = 0;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method =
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET");
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      String(method).toUpperCase() === "POST" &&
      /\/api\/first-run(?:[?#]|$)/.test(url)
    ) {
      firstRunPostCount += 1;
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
  return {
    getCount: () => firstRunPostCount,
    restore: () => {
      window.fetch = originalFetch;
    },
  };
}

async function waitForIosCloudSignInGreeting(): Promise<boolean> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = document.body?.innerText ?? "";
    if (/Sign in to Eliza(?: Cloud)?/i.test(text)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Eliza Cloud sign-in greeting");
}

async function triggerIosCloudSignInAction(): Promise<void> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tryHandleFirstRunAction(FIRST_RUN_CLOUD_LOGIN_ACTION)) return;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the cloud sign-in action handler");
}

async function waitForIosCloudOnboardingHome(): Promise<{
  home: HTMLElement;
  composer: HTMLElement;
}> {
  const home = await waitForIosOnboardingElement<HTMLElement>(
    '[data-testid="home-launcher-surface"][data-page="home"]',
    { visible: true, timeoutMs: IOS_ONBOARDING_SMOKE_TIMEOUT_MS },
  );
  const composer = await waitForIosOnboardingElement<HTMLElement>(
    '[data-testid="chat-composer-textarea"]',
    { visible: true, timeoutMs: IOS_ONBOARDING_SMOKE_TIMEOUT_MS },
  );
  return { home, composer };
}

export async function runIosCloudOnboardingSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosCloudOnboardingSmokeStarted) {
    return iosCloudOnboardingSmokeStarted;
  }
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest) return false;

  iosCloudOnboardingSmokeStarted = true;
  const request = parseIosCloudOnboardingSmokeRequest(rawRequest);
  const firstRunCounter = installFirstRunPostCounter();
  await writeIosCloudOnboardingSmokeResult({
    ok: false,
    phase: "running",
    mode: request.mode,
    startedAt: new Date().toISOString(),
  });

  try {
    let signInGreetingVisible = false;
    if (request.mode === "tap") {
      signInGreetingVisible = await waitForIosCloudSignInGreeting();
      await triggerIosCloudSignInAction();
    }

    const { home, composer } = await waitForIosCloudOnboardingHome();
    const storage = readIosCloudOnboardingSmokeStorageSnapshot();
    const firstRunPostCount = firstRunCounter.getCount();
    const activeServer = storage["elizaos:active-server"];
    const cloudActiveServer =
      typeof activeServer === "string" &&
      activeServer.includes('"kind":"cloud"');
    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );

    // Liveness contract (#14359 / #16936): the cloud agent is
    // SIWE-provisioned and live, so every lane ends with one real chat turn.
    // The result carries the reply for the harness's shared non-stub assertion.
    const livenessReply = await driveIosLivenessChatTurn(
      request.livenessPrompt,
    );

    await writeIosCloudOnboardingSmokeResult({
      ok: isIosCloudOnboardingComplete({
        homeVisible: Boolean(home),
        composerVisible: Boolean(composer),
        onboardingHidden,
        cloudActiveServer,
        firstRunPostCount,
      }),
      phase: "complete",
      mode: request.mode,
      finishedAt: new Date().toISOString(),
      signInGreetingVisible,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      firstRunPostCount,
      cloudActiveServer,
      storage,
      livenessRequested: true,
      livenessReply,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosCloudOnboardingSmokeResult({
      ok: false,
      phase: "failed",
      mode: request.mode,
      finishedAt: new Date().toISOString(),
      firstRunPostCount: firstRunCounter.getCount(),
      error: error instanceof Error ? error.message : String(error),
      storage: readIosCloudOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    firstRunCounter.restore();
    try {
      shellLocalStorage.removeItem(IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY);
    } catch (error) {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
      logger.debug(
        { error },
        "[iOSCloudOnboardingSmoke] localStorage request cleanup failed",
      );
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function fetchIosMixedContentHealth(apiBase: string): Promise<
  | {
      ok: boolean;
      status: number;
      url: string;
      body: unknown;
    }
  | {
      ok: false;
      status?: number;
      url: string;
      error: string;
    }
> {
  const url = new URL("/api/health", apiBase).href;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // error-policy:J7 diagnostics preserve status even when body is not JSON
      try {
        body = await response.text();
      } catch {
        // error-policy:J7 diagnostics preserve the health failure without a body
        body = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      url,
      body,
    };
  } catch (error) {
    // error-policy:J7 diagnostics preserve the failed health probe for the harness
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runIosMixedContentSmokeIfRequested(options?: {
  apiBase?: string;
}): Promise<boolean> {
  if (!isIOS || iosMixedContentSmokeStarted) {
    return iosMixedContentSmokeStarted;
  }
  const request = await readIosMixedContentSmokeRequest(options?.apiBase);
  if (!request) return false;

  iosMixedContentSmokeStarted = true;
  await writeIosMixedContentSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });

  const wsConstructorCalls: string[] = [];
  const originalWebSocket = window.WebSocket;
  const clientBaseUrl =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  try {
    window.WebSocket = new Proxy(originalWebSocket, {
      construct(target, args) {
        wsConstructorCalls.push(String(args[0] ?? ""));
        return Reflect.construct(target, args);
      },
    }) as typeof WebSocket;

    client.connectWs();
    const connectionState =
      typeof client.getConnectionState === "function"
        ? client.getConnectionState()
        : null;
    const restHealth = await fetchIosMixedContentHealth(request.apiBase);
    const bodyText = document.body?.innerText ?? "";
    const lostBackendOverlayAbsent =
      !/Lost backend connection/i.test(bodyText) &&
      !document.querySelector('[data-testid="connection-lost-overlay"]');

    await writeIosMixedContentSmokeResult({
      ok:
        restHealth.ok === true &&
        wsConstructorCalls.length === 0 &&
        connectionState?.state === "connected" &&
        lostBackendOverlayAbsent,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      webViewOrigin: window.location.origin,
      webViewProtocol: window.location.protocol,
      clientBaseUrl,
      expectedInsecureWebSocketUrl: new URL(
        "/ws",
        request.apiBase,
      ).href.replace(/^http:/, "ws:"),
      mixedContentWouldBlockWebSocket:
        window.location.protocol === "https:" &&
        request.apiBase.startsWith("http://"),
      webSocketConstructorCalls: wsConstructorCalls,
      connectionState,
      lostBackendOverlayAbsent,
      restHealth,
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosMixedContentSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      webViewOrigin: window.location.origin,
      clientBaseUrl,
      webSocketConstructorCalls: wsConstructorCalls,
      connectionState:
        typeof client.getConnectionState === "function"
          ? client.getConnectionState()
          : null,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    window.WebSocket = originalWebSocket;
    try {
      shellLocalStorage.removeItem(IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

export async function runIosOnboardingSmokeIfRequested(
  connectFirstRunRemoteDeepLink: (apiBase: string) => void,
): Promise<boolean> {
  if (!isIOS || iosOnboardingSmokeStarted) return iosOnboardingSmokeStarted;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
  }
  if (!rawRequest) return false;

  iosOnboardingSmokeStarted = true;
  const request = parseIosOnboardingSmokeRequest(rawRequest);
  await writeIosOnboardingSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });
  try {
    // WKWebView is not CDP-drivable, and recent iOS simulators can stop
    // `simctl openurl` behind a system "Open in <app>?" confirmation. Drive the
    // same hardened remote-connect handler that the OS deep-link route uses,
    // after React has had a chance to install its CONNECT_EVENT listener.
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    connectFirstRunRemoteDeepLink(request.apiBase);

    // Prove the post-connect surface, decoupled from the onboarding DOM — no
    // remote-address field to fill, resilient to the in-chat redesign.
    const home = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true },
    );
    const composer = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="chat-composer-textarea"]',
      { visible: true },
    );

    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );
    const storage = await waitForIosOnboardingSmokeStorageSnapshot(
      request.apiBase,
    );
    await runIosMixedContentSmokeIfRequested({ apiBase: request.apiBase });

    // Liveness contract (#14359): against a live-provider host, end the lane
    // with one real chat turn and report the reply for the harness's shared
    // non-stub assertion. Skipped for the default deterministic (stub) host.
    const livenessReply = request.liveness
      ? await driveIosLivenessChatTurn(request.livenessPrompt)
      : null;

    await writeIosOnboardingSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      storage,
      livenessRequested: request.liveness,
      livenessReply,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosOnboardingSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    try {
      shellLocalStorage.removeItem(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_ONBOARDING_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

export async function runIosOnboardingRelaunchSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosOnboardingRelaunchSmokeStarted) {
    return iosOnboardingRelaunchSmokeStarted;
  }
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest) return false;

  iosOnboardingRelaunchSmokeStarted = true;
  const request = parseIosOnboardingSmokeRequest(rawRequest);
  await writeIosOnboardingRelaunchSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });
  try {
    const home = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true },
    );
    const composer = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="chat-composer-textarea"]',
      { visible: true },
    );
    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );
    const storage = await waitForIosOnboardingSmokeStorageSnapshot(
      request.apiBase,
    );

    await writeIosOnboardingRelaunchSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      storage,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosOnboardingRelaunchSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    try {
      shellLocalStorage.removeItem(IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

export async function recordIosAuthCallbackSmoke(
  parsed: URL,
  path: string,
  url: string,
  outcome: AuthCallbackDeepLinkOutcome,
  activeServerBefore: string,
  readActiveServerSessionSnapshot: () => string,
): Promise<void> {
  // Record the auth-callback end state on ANY native platform. Pre-#13693 this
  // was iOS-only, so the Android smoke leg had no in-app readback at all (pure
  // `am start` fire-and-forget). Broadening to `isNative` lets the Android
  // smoke read the same Capacitor-Preferences handshake (backed by
  // SharedPreferences) and assert the same end state instead of trusting intent
  // resolution alone. This is a smoke seam: the body no-ops unless the harness
  // has armed the request key, so real users' deep-link handling is unchanged.
  if (!isNative) return;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
    );
  } catch {
    rawRequest = null;
  }
  rawRequest ??= await boundedPreferenceGet(
    IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
  );
  if (!rawRequest) return;

  let request: Record<string, unknown> = {};
  try {
    const parsedRequest = JSON.parse(rawRequest);
    if (parsedRequest && typeof parsedRequest === "object") {
      request = parsedRequest as Record<string, unknown>;
    }
  } catch {
    request = { malformedRequest: rawRequest };
  }

  // #13693: assert the AUTH OUTCOME, not just delivery. The security invariant
  // for this handler (see the `connect`/first-run-remote cases above) is that
  // an OS-delivered deep link NEVER establishes or swaps an authenticated
  // session. Compare the real active-server key before/after handling the
  // callback so a pre-authenticated simulator passes when the callback leaves
  // the session untouched, while a regression that authenticates from the deep
  // link flips `sessionChanged=true`.
  let activeServerAfter = "";
  try {
    activeServerAfter = readActiveServerSessionSnapshot();
  } catch (error) {
    // error-policy:J7 diagnostics readback — the smoke must fail closed when it
    // cannot observe the auth outcome it is supposed to prove.
    await writeIosAuthCallbackSmokeResult({
      ok: false,
      phase: "failed",
      classification: outcome.classification,
      accepted: outcome.accepted,
      reason: outcome.reason,
      error:
        error instanceof Error
          ? error.message
          : `active-server readback failed: ${String(error)}`,
      path,
      url,
      state: parsed.searchParams.get("state") ?? "",
      code: parsed.searchParams.get("code") ?? "",
      query: Object.fromEntries(parsed.searchParams.entries()),
      request,
    });
    return;
  }

  await writeIosAuthCallbackSmokeResult({
    ok: true,
    phase: "handled",
    classification: outcome.classification,
    accepted: outcome.accepted,
    reason: outcome.reason,
    sessionEstablished: activeServerAfter.length > 0,
    sessionChanged: activeServerAfter !== activeServerBefore,
    activeServerBeforePresent: activeServerBefore.length > 0,
    activeServerAfterPresent: activeServerAfter.length > 0,
    path,
    url,
    state: parsed.searchParams.get("state") ?? "",
    code: parsed.searchParams.get("code") ?? "",
    query: Object.fromEntries(parsed.searchParams.entries()),
    request,
  });
}

export async function runNativeSmokeDrivers(
  connectRemote: (apiBase: string) => void,
): Promise<void> {
  if (!isIOS) return;
  await Promise.all([
    runIosOnboardingSmokeIfRequested(connectRemote),
    runIosCloudOnboardingSmokeIfRequested(),
    runIosOnboardingRelaunchSmokeIfRequested(),
    runIosAttachmentSmokeIfRequested({
      isIOS,
      getApiBaseUrl: () => client.getBaseUrl(),
      getPreference: boundedPreferenceGet,
      removePreference: (key) =>
        boundedPreferenceWrite(() => Preferences.remove({ key })),
      writeResult: writeIosPreferenceSmokeResult,
      waitForElement: waitForIosOnboardingElement,
      readStorageSnapshot: readIosOnboardingSmokeStorageSnapshot,
    }),
    import("./ios-voice-selftest-smoke").then(
      ({ runIosVoiceSelfTestSmokeIfRequested }) =>
        runIosVoiceSelfTestSmokeIfRequested({
          isIOS,
          client,
          getPreference: boundedPreferenceGet,
          removePreference: (key) =>
            boundedPreferenceWrite(() => Preferences.remove({ key })),
          writeResult: writeIosPreferenceSmokeResult,
          readStorageSnapshot: readIosOnboardingSmokeStorageSnapshot,
        }),
    ),
  ]);
}
