import { expect, type Page, test } from "@playwright/test";
import {
  assertReadyChecks,
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type NativePluginMethod = {
  name: string;
  rtype: "promise" | "callback";
};

type NativePluginHeader = {
  name: string;
  methods: NativePluginMethod[];
};

type FixtureWindow = Window & {
  Capacitor?: {
    Plugins?: Record<string, unknown>;
    PluginHeaders?: NativePluginHeader[];
    nativePromise?: (
      pluginName: string,
      methodName: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    nativeCallback?: (
      pluginName: string,
      methodName: string,
      options: Record<string, unknown> | undefined,
      callback: (payload: unknown) => void,
    ) => Promise<string>;
  };
  __elizaUiSmokeBarcodeScanner?: {
    scanBarcode(options?: Record<string, unknown>): Promise<{
      ScanResult: string;
      format: number;
    }>;
  };
  CapacitorCustomPlatform?: { name: string };
  androidBridge?: Record<string, unknown>;
  __evenBridge?: Record<string, unknown>;
  __mentraBridge?: Record<string, unknown>;
  __elizaNativeFixture?: {
    clipboard: string;
    phone: {
      placedCalls: Array<{ number: string }>;
      openedDialers: Array<Record<string, unknown> | null>;
    };
    messages: {
      sent: Array<{ address: string; body: string }>;
      roleRequests: number;
      roleHeld: boolean;
    };
    contacts: {
      created: Array<Record<string, unknown>>;
      imported: string[];
    };
    remoteSession: {
      closed: number;
      openedUrls: string[];
      sent: string[];
    };
    smartglasses: {
      writes: Array<{ side: string; hex: string }>;
      micStates: boolean[];
      wifiCredentials: Array<{ ssid: string; password: string }>;
      wifiSetupRequests: string[];
    };
  };
  facewearSmartglassesReport?: {
    connected?: boolean;
    wifi?: { networks?: string[]; status?: string };
  };
};

const ANDROID_ELIZA_UA =
  "Mozilla/5.0 (Linux; Android 15; ElizaOS QA) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 ElizaOS/qa";

const RED_ERROR_TEXT =
  /Could not open app|Something went wrong|Cannot read properties|Unhandled Runtime Error|Traceback|TypeError:|ReferenceError:|Failed to load view/i;

const BENIGN_CONSOLE_PATTERNS = [
  /Capacitor plugin ".+" already registered/i,
  /\[Eliza\] Network plugin not available/i,
  /\[Eliza\] StatusBar plugin not available/i,
  /\[eliza\]\[startup:init\] Device bridge unavailable/i,
  /\[eliza\]\[startup:init\] Mobile agent tunnel/i,
  /WebSocket connection to 'ws:\/\/127\.0\.0\.1:31337\/api\/local-inference\/device-bridge\?token=ui-smoke-local-agent-token' failed/i,
  /Web Bluetooth is not available/i,
];
const BENIGN_PAGEERROR_PATTERNS = [
  /Cannot read properties of undefined \(reading 'catch'\)/i,
];
const GENERIC_RESOURCE_404 =
  /Failed to load resource: the server responded with a status of 404 \(Not Found\)/i;
const BENIGN_HTTP_ERROR_PATTERNS = [
  /\/apps\/assets\/[^/]+\.(?:js|css|woff2?|map)$/i,
];

const PLUGIN_HEADERS: NativePluginHeader[] = [
  header("App", [
    "addListener:callback",
    "removeListener",
    "getLaunchUrl",
    "getState",
    "getInfo",
  ]),
  header("Keyboard", [
    "addListener:callback",
    "removeListener",
    "setResizeMode",
    "setScroll",
    "setAccessoryBarVisible",
  ]),
  header("Network", ["addListener:callback", "removeListener", "getStatus"]),
  header("StatusBar", ["setStyle", "setOverlaysWebView", "setBackgroundColor"]),
  header("Preferences", ["get", "set", "remove", "keys", "clear", "configure"]),
  header("CapacitorBackgroundRunner", [
    "dispatchEvent",
    "checkPermissions",
    "requestPermissions",
    "addListener:callback",
    "removeNotificationListeners",
  ]),
  header("Haptics", ["impact", "notification", "vibrate"]),
  header("Agent", [
    "start",
    "stop",
    "getStatus",
    "chat",
    "getLocalAgentToken",
    "request",
  ]),
  header("ElizaPhone", [
    "getStatus",
    "placeCall",
    "openDialer",
    "listRecentCalls",
    "saveCallTranscript",
  ]),
  header("ElizaMessages", ["sendSms", "listMessages"]),
  header("ElizaContacts", ["listContacts", "createContact", "importVCard"]),
  header("ElizaSystem", [
    "getStatus",
    "requestRole",
    "openSettings",
    "openNetworkSettings",
    "getDeviceSettings",
    "setScreenBrightness",
    "setVolume",
    "openWriteSettings",
    "openDisplaySettings",
    "openSoundSettings",
  ]),
  header("ElizaIntent", [
    "scheduleAlarm",
    "receiveIntent",
    "getPairingStatus",
    "setPairingStatus",
  ]),
  header("CapacitorBarcodeScanner", ["scanBarcode"]),
];

function header(name: string, methods: string[]): NativePluginHeader {
  return {
    name,
    methods: methods.map((entry) => {
      const [methodName, rawType] = entry.split(":");
      return {
        name: methodName,
        rtype: rawType === "callback" ? "callback" : "promise",
      };
    }),
  };
}

function installIssueGuards(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) return;
    if (GENERIC_RESOURCE_404.test(text)) return;
    if (message.type() === "error" || RED_ERROR_TEXT.test(text)) {
      issues.push(`console ${message.type()}: ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    if (
      BENIGN_PAGEERROR_PATTERNS.some((pattern) => pattern.test(error.message))
    ) {
      return;
    }
    issues.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const failureText = request.failure()?.errorText ?? "";
    if (failureText === "net::ERR_ABORTED") return;
    issues.push(`requestfailed: ${url} ${failureText}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (BENIGN_HTTP_ERROR_PATTERNS.some((pattern) => pattern.test(url))) return;
    issues.push(`response ${status}: ${url}`);
  });
  return issues;
}

async function expectNoIssues(
  page: Page,
  issues: readonly string[],
  label: string,
): Promise<void> {
  await expect(page.locator("body")).not.toContainText(RED_ERROR_TEXT);
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    metrics.scrollWidth,
    `${label}: horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 2);
  expect(issues, label).toEqual([]);
}

async function openAppWindow(
  page: Page,
  routeName: string,
  path: string,
  readyChecks: readonly ReadyCheck[],
): Promise<void> {
  await page.goto(
    `/?appWindow=1&qaApp=${encodeURIComponent(routeName)}#${path}`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.locator("#root")).toBeVisible({ timeout: 90_000 });
  await assertReadyChecks(page, routeName, readyChecks, "any", 90_000);
}

async function openPhoneCompanionMode(page: Page): Promise<void> {
  await page.goto("/?mode=companion", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#root")).toBeVisible({ timeout: 90_000 });
  await assertReadyChecks(
    page,
    "phone companion",
    [{ text: "Companion" }, { text: "Pair with Eliza" }],
    "any",
    90_000,
  );
}

async function installDeterministicNativeBridge(
  page: Page,
  options: { nativePlatform?: boolean } = {},
): Promise<void> {
  const nativePlatform = options.nativePlatform ?? true;
  const pairingQr = Buffer.from(
    JSON.stringify({
      agentId: "agent-ui-smoke",
      pairingCode: "123456",
      ingressUrl: "ws://127.0.0.1:31337/input",
      sessionToken: "session-ui-smoke",
    }),
  ).toString("base64");

  await page.addInitScript(
    ({ headers, nativePlatform: isNativePlatform, qr }) => {
      const win = window as FixtureWindow;
      const fixedNow = Date.parse("2026-01-01T12:00:00.000Z");
      const preferences = new Map<string, string>();
      const preferenceStoragePrefix = "__elizaNativePreference:";
      const activeServer = isNativePlatform
        ? {
            id: "local:android",
            kind: "remote",
            label: "On-device agent",
            apiBase: "eliza-local-agent://ipc",
          }
        : {
            id: "local:embedded",
            kind: "local",
            label: "This device",
          };
      preferences.set("eliza:first-run-complete", "1");
      preferences.set("eliza:setup:step", "activate");
      preferences.set("eliza:ui-shell-mode", "native");
      preferences.set(
        "eliza:mobile-runtime-mode",
        isNativePlatform ? "local" : "",
      );
      preferences.set("elizaos:active-server", JSON.stringify(activeServer));

      function hydratePersistedPreferences() {
        try {
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const storageKey = window.localStorage.key(index);
            if (!storageKey?.startsWith(preferenceStoragePrefix)) continue;
            const key = storageKey.slice(preferenceStoragePrefix.length);
            const value = window.localStorage.getItem(storageKey);
            if (value !== null) preferences.set(key, value);
          }
        } catch {
          /* localStorage may be unavailable in embedded shells */
        }
      }

      function persistPreference(key: string, value: string) {
        try {
          window.localStorage.setItem(
            `${preferenceStoragePrefix}${key}`,
            value,
          );
        } catch {
          /* localStorage may be unavailable in embedded shells */
        }
      }

      function removePersistedPreference(key: string) {
        try {
          window.localStorage.removeItem(`${preferenceStoragePrefix}${key}`);
        } catch {
          /* localStorage may be unavailable in embedded shells */
        }
      }

      function clearPersistedPreferences() {
        try {
          const keys: string[] = [];
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const storageKey = window.localStorage.key(index);
            if (storageKey?.startsWith(preferenceStoragePrefix)) {
              keys.push(storageKey);
            }
          }
          for (const storageKey of keys) {
            window.localStorage.removeItem(storageKey);
          }
        } catch {
          /* localStorage may be unavailable in embedded shells */
        }
      }

      hydratePersistedPreferences();
      const listeners = new Map<
        string,
        {
          pluginName: string;
          methodName: string;
          options: Record<string, unknown> | undefined;
          callback: (payload: unknown) => void;
        }
      >();
      let listenerId = 0;

      const contacts = [
        {
          id: "contact-ada",
          lookupKey: "lookup-ada",
          displayName: "Ada Relay",
          phoneNumbers: ["+1 (415) 555-0101"],
          emailAddresses: ["ada@example.test"],
          starred: true,
        },
        {
          id: "contact-grace",
          lookupKey: "lookup-grace",
          displayName: "Grace Hopper",
          phoneNumbers: ["+1 (415) 555-0102"],
          emailAddresses: ["grace@example.test"],
          starred: false,
        },
      ];
      const recentCalls = [
        {
          id: "call-ada",
          number: "+14155550101",
          cachedName: "Ada Relay",
          date: fixedNow - 60_000,
          durationSeconds: 121,
          type: "outgoing",
          rawType: 2,
          isNew: false,
          phoneAccountId: "ui-smoke",
          geocodedLocation: "San Francisco, CA",
          transcription: null,
          voicemailUri: null,
          agentTranscript: null,
          agentSummary: null,
          agentTranscriptUpdatedAt: null,
        },
        {
          id: "call-grace",
          number: "+14155550102",
          cachedName: "Grace Hopper",
          date: fixedNow - 180_000,
          durationSeconds: 0,
          type: "missed",
          rawType: 3,
          isNew: true,
          phoneAccountId: "ui-smoke",
          geocodedLocation: null,
          transcription: null,
          voicemailUri: null,
          agentTranscript: null,
          agentSummary: null,
          agentTranscriptUpdatedAt: null,
        },
      ];
      const initialMessages = [
        {
          id: "sms-1",
          threadId: "thread-alpha",
          address: "+14155550101",
          body: "Can you review the build?",
          date: fixedNow - 120_000,
          type: 1,
          read: false,
        },
        {
          id: "sms-2",
          threadId: "thread-alpha",
          address: "+14155550101",
          body: "Yes, checking the deterministic smoke path now.",
          date: fixedNow - 90_000,
          type: 2,
          read: true,
        },
        {
          id: "sms-3",
          threadId: "thread-beta",
          address: "+14155550102",
          body: "Pairing window is ready.",
          date: fixedNow - 30_000,
          type: 1,
          read: true,
        },
      ];
      const fixture = {
        clipboard: "",
        phone: {
          placedCalls: [] as Array<{ number: string }>,
          openedDialers: [] as Array<Record<string, unknown> | null>,
        },
        messages: {
          sent: [] as Array<{ address: string; body: string }>,
          roleRequests: 0,
          roleHeld: false,
        },
        contacts: {
          created: [] as Array<Record<string, unknown>>,
          imported: [] as string[],
        },
        remoteSession: {
          closed: 0,
          openedUrls: [] as string[],
          sent: [] as string[],
        },
        smartglasses: {
          writes: [] as Array<{ side: string; hex: string }>,
          micStates: [] as boolean[],
          wifiCredentials: [] as Array<{ ssid: string; password: string }>,
          wifiSetupRequests: [] as string[],
        },
      };

      win.__elizaNativeFixture = fixture;
      win.__elizaUiSmokeBarcodeScanner = {
        scanBarcode: async () => ({ ScanResult: qr, format: 17 }),
      };
      try {
        window.localStorage.setItem(
          "__elizaUiSmokeBarcodeScannerResult",
          JSON.stringify({ ScanResult: qr, format: 17 }),
        );
      } catch {
        /* localStorage may be unavailable in embedded shells */
      }
      if (isNativePlatform) {
        win.CapacitorCustomPlatform = { name: "android" };
        win.androidBridge = {};
      }
      try {
        window.localStorage.removeItem("eliza.companion.nav.v1");
      } catch {
        /* storage can be unavailable on opaque origins */
      }
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            fixture.clipboard = value;
          },
        },
      });

      const OriginalWebSocket = window.WebSocket;
      class UiSmokeSessionWebSocket extends EventTarget {
        binaryType: BinaryType = "blob";
        bufferedAmount = 0;
        extensions = "";
        onclose: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onopen: ((event: Event) => void) | null = null;
        protocol = "";
        readyState = WebSocket.CONNECTING;
        url = "";

        constructor(url: string) {
          super();
          this.url = url;
          fixture.remoteSession.openedUrls.push(url);
          window.setTimeout(() => {
            this.readyState = WebSocket.OPEN;
            const event = new Event("open");
            this.dispatchEvent(event);
            this.onopen?.(event);
          }, 0);
        }

        close(): void {
          this.readyState = WebSocket.CLOSED;
          fixture.remoteSession.closed += 1;
          const event = new Event("close");
          this.dispatchEvent(event);
          this.onclose?.(event);
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          fixture.remoteSession.sent.push(
            typeof data === "string" ? data : "[binary]",
          );
        }
      }
      function UiSmokeWebSocket(
        this: WebSocket,
        url: string | URL,
        protocols?: string | string[],
      ) {
        const normalizedUrl = String(url);
        if (normalizedUrl.includes("session-ui-smoke")) {
          return new UiSmokeSessionWebSocket(normalizedUrl);
        }
        return new OriginalWebSocket(url, protocols);
      }
      Object.assign(UiSmokeWebSocket, {
        CLOSED: WebSocket.CLOSED,
        CLOSING: WebSocket.CLOSING,
        CONNECTING: WebSocket.CONNECTING,
        OPEN: WebSocket.OPEN,
      });
      UiSmokeWebSocket.prototype = UiSmokeSessionWebSocket.prototype;
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        value: UiSmokeWebSocket as unknown as typeof WebSocket,
      });

      function clone<T>(value: T): T {
        return JSON.parse(JSON.stringify(value)) as T;
      }

      function hex(data: Uint8Array): string {
        return Array.from(data)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      }

      function messages() {
        return {
          messages: [
            ...initialMessages,
            ...fixture.messages.sent.map((message, index) => ({
              id: `sent-${index + 1}`,
              threadId: `sent-${message.address.replace(/[^0-9+]/g, "")}`,
              address: message.address,
              body: message.body,
              date: fixedNow + index + 1,
              type: 2,
              read: true,
            })),
          ],
        };
      }

      function systemStatus() {
        return {
          packageName: "ai.eliza.ui.smoke",
          roles: [
            {
              role: "sms",
              androidRole: "android.app.role.SMS",
              held: fixture.messages.roleHeld,
              holders: fixture.messages.roleHeld
                ? ["ai.eliza.ui.smoke"]
                : ["com.android.messaging"],
              available: true,
            },
            {
              role: "dialer",
              androidRole: "android.app.role.DIALER",
              held: true,
              holders: ["ai.eliza.ui.smoke"],
              available: true,
            },
          ],
        };
      }

      function pluginResult(
        pluginName: string,
        methodName: string,
        options: Record<string, unknown> | undefined,
      ): unknown {
        if (pluginName === "App") {
          if (methodName === "getLaunchUrl") return { url: "" };
          if (methodName === "getState") return { isActive: true };
          if (methodName === "getInfo") {
            return {
              name: "Eliza UI Smoke",
              id: "ai.eliza.ui.smoke",
              build: "1",
              version: "0.0.0-ui-smoke",
            };
          }
          return {};
        }
        if (pluginName === "Keyboard" || pluginName === "StatusBar") return {};
        if (pluginName === "Network") {
          return { connected: true, connectionType: "wifi" };
        }
        if (pluginName === "Preferences") {
          const key = String(options?.key ?? "");
          if (methodName === "get")
            return { value: preferences.get(key) ?? null };
          if (methodName === "set") {
            const value = String(options?.value ?? "");
            preferences.set(key, value);
            persistPreference(key, value);
            return {};
          }
          if (methodName === "remove") {
            preferences.delete(key);
            removePersistedPreference(key);
            return {};
          }
          if (methodName === "keys") {
            return { keys: Array.from(preferences.keys()) };
          }
          if (methodName === "clear") {
            preferences.clear();
            clearPersistedPreferences();
            return {};
          }
          return {};
        }
        if (pluginName === "CapacitorBackgroundRunner") {
          if (methodName === "checkPermissions")
            return { notifications: "granted" };
          if (methodName === "requestPermissions") {
            return { notifications: "granted" };
          }
          return {};
        }
        if (pluginName === "Haptics") return {};
        if (pluginName === "Agent") {
          if (methodName === "getLocalAgentToken") {
            return { available: true, token: "ui-smoke-local-agent-token" };
          }
          if (methodName === "request") {
            return {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ok: true }),
            };
          }
          if (methodName === "chat") {
            return {
              text: "deterministic agent response",
              agentName: "UI Smoke",
            };
          }
          if (methodName === "stop") return { ok: true };
          return {
            state: "running",
            agentName: "UI Smoke",
            port: 31337,
            startedAt: fixedNow,
            error: null,
          };
        }
        if (pluginName === "ElizaPhone") {
          if (methodName === "getStatus") {
            return {
              hasTelecom: true,
              canPlaceCalls: true,
              isDefaultDialer: true,
              defaultDialerPackage: "ai.eliza.ui.smoke",
            };
          }
          if (methodName === "listRecentCalls") {
            const number =
              typeof options?.number === "string" ? options.number : null;
            return {
              calls: clone(
                number
                  ? recentCalls.filter((call) => call.number === number)
                  : recentCalls,
              ),
            };
          }
          if (methodName === "placeCall") {
            fixture.phone.placedCalls.push({
              number: String(options?.number ?? ""),
            });
            return {};
          }
          if (methodName === "openDialer") {
            fixture.phone.openedDialers.push(options ?? null);
            return {};
          }
          if (methodName === "saveCallTranscript") {
            return { updatedAt: fixedNow + 1_000 };
          }
        }
        if (pluginName === "ElizaMessages") {
          if (methodName === "listMessages") return clone(messages());
          if (methodName === "sendSms") {
            fixture.messages.sent.push({
              address: String(options?.address ?? ""),
              body: String(options?.body ?? ""),
            });
            return {
              messageId: `sent-${fixture.messages.sent.length}`,
              messageUri: `content://sms/sent/${fixture.messages.sent.length}`,
            };
          }
        }
        if (pluginName === "ElizaContacts") {
          if (methodName === "listContacts") {
            const limit =
              typeof options?.limit === "number"
                ? options.limit
                : contacts.length;
            return { contacts: clone(contacts.slice(0, limit)) };
          }
          if (methodName === "createContact") {
            const created = {
              id: `contact-created-${fixture.contacts.created.length + 1}`,
              lookupKey: `lookup-created-${fixture.contacts.created.length + 1}`,
              displayName: String(options?.displayName ?? ""),
              phoneNumbers: [
                ...("phoneNumber" in (options ?? {})
                  ? [String(options?.phoneNumber ?? "")]
                  : []),
                ...(Array.isArray(options?.phoneNumbers)
                  ? options.phoneNumbers.map(String)
                  : []),
              ].filter(Boolean),
              emailAddresses: [
                ...("emailAddress" in (options ?? {})
                  ? [String(options?.emailAddress ?? "")]
                  : []),
                ...(Array.isArray(options?.emailAddresses)
                  ? options.emailAddresses.map(String)
                  : []),
              ].filter(Boolean),
              starred: false,
            };
            contacts.push(created);
            fixture.contacts.created.push(clone(options ?? {}));
            return { id: created.id };
          }
          if (methodName === "importVCard") {
            fixture.contacts.imported.push(String(options?.vcardText ?? ""));
            return { imported: [] };
          }
        }
        if (pluginName === "ElizaSystem") {
          if (methodName === "getStatus") return systemStatus();
          if (methodName === "requestRole") {
            if (options?.role === "sms") {
              fixture.messages.roleRequests += 1;
              fixture.messages.roleHeld = true;
            }
            return { role: options?.role ?? "sms", held: true, resultCode: -1 };
          }
          if (methodName === "getDeviceSettings") {
            return {
              brightness: 0.67,
              brightnessMode: "manual",
              canWriteSettings: true,
              volumes: [
                { stream: "music", current: 7, max: 15 },
                { stream: "ring", current: 4, max: 7 },
              ],
            };
          }
          if (methodName === "setScreenBrightness") {
            return {
              brightness: Number(options?.brightness ?? 0.67),
              brightnessMode: "manual",
              canWriteSettings: true,
              volumes: [],
            };
          }
          if (methodName === "setVolume") {
            return {
              stream: options?.stream ?? "music",
              current: Number(options?.volume ?? 0),
              max: 15,
            };
          }
          return {};
        }
        if (pluginName === "ElizaIntent") {
          if (methodName === "getPairingStatus") {
            return { paired: false, agentUrl: null, deviceId: null };
          }
          if (methodName === "setPairingStatus") return { ok: true };
          return { accepted: false, reason: "ui-smoke" };
        }
        if (pluginName === "CapacitorBarcodeScanner") {
          return { ScanResult: qr, format: 17 };
        }
        return {};
      }

      const cap = {
        ...(win.Capacitor ?? {}),
        getPlatform: () => (isNativePlatform ? "android" : "web"),
        isNativePlatform: () => isNativePlatform,
        isPluginAvailable: (pluginName: string) =>
          isNativePlatform &&
          headers.some(
            (entry: NativePluginHeader) => entry.name === pluginName,
          ),
        PluginHeaders: isNativePlatform ? headers : [],
        nativePromise: async (
          pluginName: string,
          methodName: string,
          options?: Record<string, unknown>,
        ) => {
          if (methodName === "removeListener") {
            const callbackId = String(options?.callbackId ?? "");
            listeners.delete(callbackId);
            return {};
          }
          return pluginResult(pluginName, methodName, options);
        },
        nativeCallback: async (
          pluginName: string,
          methodName: string,
          options: Record<string, unknown> | undefined,
          callback: (payload: unknown) => void,
        ) => {
          const callbackId = `listener-${++listenerId}`;
          listeners.set(callbackId, {
            pluginName,
            methodName,
            options,
            callback,
          });
          return callbackId;
        },
      };
      cap.Plugins = {
        ...(win.Capacitor?.Plugins ?? {}),
        App: {
          addListener: cap.nativeCallback,
          getInfo: (options?: Record<string, unknown>) =>
            cap.nativePromise("App", "getInfo", options),
          getLaunchUrl: (options?: Record<string, unknown>) =>
            cap.nativePromise("App", "getLaunchUrl", options),
          getState: (options?: Record<string, unknown>) =>
            cap.nativePromise("App", "getState", options),
          removeListener: (options?: Record<string, unknown>) =>
            cap.nativePromise("App", "removeListener", options),
        },
        Keyboard: {
          addListener: cap.nativeCallback,
          removeListener: (options?: Record<string, unknown>) =>
            cap.nativePromise("Keyboard", "removeListener", options),
          setAccessoryBarVisible: (options?: Record<string, unknown>) =>
            cap.nativePromise("Keyboard", "setAccessoryBarVisible", options),
          setResizeMode: (options?: Record<string, unknown>) =>
            cap.nativePromise("Keyboard", "setResizeMode", options),
          setScroll: (options?: Record<string, unknown>) =>
            cap.nativePromise("Keyboard", "setScroll", options),
        },
        Network: {
          addListener: cap.nativeCallback,
          getStatus: (options?: Record<string, unknown>) =>
            cap.nativePromise("Network", "getStatus", options),
          removeListener: (options?: Record<string, unknown>) =>
            cap.nativePromise("Network", "removeListener", options),
        },
        StatusBar: {
          setBackgroundColor: (options?: Record<string, unknown>) =>
            cap.nativePromise("StatusBar", "setBackgroundColor", options),
          setOverlaysWebView: (options?: Record<string, unknown>) =>
            cap.nativePromise("StatusBar", "setOverlaysWebView", options),
          setStyle: (options?: Record<string, unknown>) =>
            cap.nativePromise("StatusBar", "setStyle", options),
        },
      };
      win.Capacitor = cap;

      const bridgeListeners = new Set<(event: unknown) => void>();
      const emitBridgeEvent = (event: unknown) => {
        for (const callback of bridgeListeners) callback(event);
      };
      win.__evenBridge = {
        onEvent(callback: (event: unknown) => void) {
          bridgeListeners.add(callback);
          return () => bridgeListeners.delete(callback);
        },
        write(side: string, data: Uint8Array | number[]) {
          const bytes =
            data instanceof Uint8Array ? data : Uint8Array.from(data);
          fixture.smartglasses.writes.push({ side, hex: hex(bytes) });
          return Promise.resolve({ ok: true });
        },
        send(side: string, data: Uint8Array | number[]) {
          const bytes =
            data instanceof Uint8Array ? data : Uint8Array.from(data);
          fixture.smartglasses.writes.push({ side, hex: hex(bytes) });
          return Promise.resolve({ ok: true });
        },
        setMicState(enabled: boolean) {
          fixture.smartglasses.micStates.push(Boolean(enabled));
          if (enabled) {
            window.setTimeout(
              () =>
                emitBridgeEvent({
                  type: "mic_pcm",
                  pcm: [1, 2, 3, 4, 5, 6, 7, 8],
                }),
              0,
            );
          }
          return Promise.resolve({ ok: true });
        },
        audioControl(enabled: boolean) {
          fixture.smartglasses.micStates.push(Boolean(enabled));
          return Promise.resolve({ ok: true });
        },
        requestWifiScan() {
          return Promise.resolve({
            networks: [{ ssid: "LabNet" }, { ssid: "DeviceRig" }],
          });
        },
        requestWifiStatus() {
          return Promise.resolve({
            connected: true,
            ssid: "LabNet",
            localIp: "192.168.4.8",
            networks: ["LabNet", "DeviceRig"],
          });
        },
        setWifiCredentials(ssid: string, password: string) {
          fixture.smartglasses.wifiCredentials.push({ ssid, password });
          return Promise.resolve({ status: `Credentials sent for ${ssid}` });
        },
        requestWifiSetup(reason?: string) {
          fixture.smartglasses.wifiSetupRequests.push(String(reason ?? ""));
          return Promise.resolve({ status: "Native Wi-Fi setup requested" });
        },
      };
      win.__mentraBridge = win.__evenBridge;
    },
    { headers: PLUGIN_HEADERS, nativePlatform, qr: pairingQr },
  );
}

async function readFixture(
  page: Page,
): Promise<FixtureWindow["__elizaNativeFixture"]> {
  return page.evaluate(() => {
    return (window as FixtureWindow).__elizaNativeFixture;
  });
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
});

test.describe("Android communications app interactions", () => {
  test.use({ userAgent: ANDROID_ELIZA_UA });

  test.beforeEach(async ({ page }) => {
    await installDeterministicNativeBridge(page, { nativePlatform: true });
  });

  test("phone, messages, and contacts use deterministic native data through real controls", async ({
    page,
  }) => {
    const issues = installIssueGuards(page);
    await hideContinuousChatOverlay(page);
    await installDefaultAppRoutes(page);

    await openAppWindow(page, "phone", "/apps/phone", [
      { selector: '[data-testid="phone-shell"]' },
    ]);
    for (const digit of ["4", "1", "5", "5", "5", "5", "0", "1", "9", "9"]) {
      await page.getByTestId(`phone-dial-key-${digit}`).click();
    }
    await page.getByTestId("phone-dial-backspace").click();
    await expect(page.locator("output").first()).toContainText("415555019");
    await page.getByTestId("phone-dial-call").click();
    await expect
      .poll(
        async () => (await readFixture(page))?.phone.placedCalls.at(-1)?.number,
      )
      .toBe("415555019");

    await page.getByRole("tab", { name: "Recent" }).click();
    await expect(page.getByText("Ada Relay")).toBeVisible();
    await expect(page.getByText("Grace Hopper")).toBeVisible();
    await page.getByRole("button", { name: /Ada Relay/ }).click();
    await expect
      .poll(
        async () => (await readFixture(page))?.phone.placedCalls.at(-1)?.number,
      )
      .toBe("+14155550101");
    await expectNoIssues(
      page,
      issues.splice(0),
      "phone deterministic controls",
    );

    await openAppWindow(page, "messages", "/apps/messages", [
      { selector: '[data-testid="messages-shell"]' },
    ]);
    await page.getByTestId("messages-request-sms-role").click();
    await expect
      .poll(async () => (await readFixture(page))?.messages.roleRequests)
      .toBe(1);
    await page.getByTestId("messages-thread-thread-alpha").click();
    const threadPanel = page.getByTestId("messages-composer-panel");
    await expect(
      threadPanel.getByText("Can you review the build?"),
    ).toBeVisible();
    await expect(
      threadPanel.getByText("Yes, checking the deterministic smoke path now."),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: /^(Back to threads|messages\.backToThreads)$/,
      })
      .click();
    await page.getByTestId("messages-new").click();
    await page.getByTestId("messages-compose-address").fill("+14155550103");
    await page
      .getByTestId("messages-compose-body")
      .fill("Deterministic SMS send from Playwright");
    await expect(page.getByTestId("messages-send")).toBeEnabled();
    await page.getByTestId("messages-send").click();
    await expect(page.getByRole("status")).toContainText("Message sent.");
    await expect
      .poll(async () => (await readFixture(page))?.messages.sent.at(-1))
      .toEqual({
        address: "+14155550103",
        body: "Deterministic SMS send from Playwright",
      });
    await expectNoIssues(
      page,
      issues.splice(0),
      "messages deterministic controls",
    );

    await openAppWindow(page, "contacts", "/apps/contacts", [
      { selector: '[data-testid="contacts-shell"]' },
    ]);
    await expect(page.getByText("Ada Relay")).toBeVisible();
    await page.getByTestId("contacts-search").fill("Grace");
    await expect(page.getByText("Grace Hopper")).toBeVisible();
    await expect(page.getByText("Ada Relay")).toHaveCount(0);
    await page.getByTestId("contacts-search").fill("");
    await page.getByRole("button", { name: /Ada Relay/ }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Ada Relay" }),
    ).toBeVisible();
    await expect(page.getByText("ada@example.test")).toBeVisible();
    await page
      .getByRole("button", { name: /^(Back to list|nav\.backToList)$/ })
      .click();
    await page.getByTestId("contacts-new").click();
    await page.getByLabel("Name").fill("Lin Test");
    await page.getByLabel("Phone").fill("+1 415 555 0199");
    await page.getByLabel("Email").fill("lin@example.test");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Lin Test")).toBeVisible();
    await expect
      .poll(async () => (await readFixture(page))?.contacts.created.at(-1))
      .toEqual({
        displayName: "Lin Test",
        phoneNumber: "+1 415 555 0199",
        emailAddress: "lin@example.test",
      });
    await expectNoIssues(
      page,
      issues.splice(0),
      "contacts deterministic controls",
    );
  });

  test("phone companion pairing form is reachable and deterministic", async ({
    page,
  }) => {
    const issues = installIssueGuards(page);
    await installDefaultAppRoutes(page);
    await page.route("http://127.0.0.1:31337/vnc**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Remote session fixture</title><main>Remote session fixture</main>",
      });
    });

    await openPhoneCompanionMode(page);
    await expect(page.getByRole("heading", { name: "Companion" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      page.getByRole("button", { name: /^(Pair|Re-pair)$/ }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await (window as FixtureWindow).Capacitor?.nativePromise?.(
        "Preferences",
        "set",
        {
          key: "eliza.companion.nav.v1",
          value: JSON.stringify(["chat", "pairing"]),
        },
      );
    });
    await openPhoneCompanionMode(page);
    await expect(
      page.getByRole("heading", { name: "Pair with Eliza" }),
    ).toBeVisible();
    const manualPairingPayload = Buffer.from(
      JSON.stringify({
        agentId: "agent-ui-smoke-manual",
        pairingCode: "manual-ui-smoke",
        ingressUrl: "ws://127.0.0.1:31337/input",
        sessionToken: "session-ui-smoke-manual",
      }),
    ).toString("base64");
    await page.getByLabel("Or paste payload").fill(manualPairingPayload);
    await page.getByRole("button", { name: "Pair device" }).click();
    await expect(page.getByRole("button", { name: "Exit" })).toBeVisible();
    await expect(page.getByTitle("Remote desktop")).toHaveAttribute(
      "src",
      /session-ui-smoke-manual/,
    );
    await expect
      .poll(
        async () =>
          (await readFixture(page))?.remoteSession.openedUrls.at(-1) ?? "",
      )
      .toContain("session-ui-smoke-manual");
    await page.getByRole("button", { name: "Exit" }).click();
    await expect(
      page.getByRole("heading", { name: "Pair with Eliza" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Scan QR code" }).click();
    await expect(page.getByRole("button", { name: "Exit" })).toBeVisible();
    await expect(page.getByTitle("Remote desktop")).toHaveAttribute(
      "src",
      /session-ui-smoke/,
    );
    await expect
      .poll(
        async () =>
          (await readFixture(page))?.remoteSession.openedUrls.at(-1) ?? "",
      )
      .toContain("session-ui-smoke");
    await page.getByRole("button", { name: "Exit" }).click();
    await expect(
      page.getByRole("heading", { name: /^(Companion|Pair with Eliza)$/ }),
    ).toBeVisible();

    await expectNoIssues(page, issues.splice(0), "phone companion pairing");
  });
});

test.describe("Facewear and smartglasses GUI interactions", () => {
  test.beforeEach(async ({ page }) => {
    await installDeterministicNativeBridge(page, { nativePlatform: false });
  });

  test("facewear and smartglasses device flows perform deterministic connect and bridge actions", async ({
    page,
  }) => {
    const issues = installIssueGuards(page);
    let facewearStatusRequests = 0;
    await hideContinuousChatOverlay(page);

    await installDefaultAppRoutes(page);
    await page.route("**/api/facewear/status", async (route) => {
      facewearStatusRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connected: true,
          devices: [
            {
              id: "g1-ui-smoke",
              kind: "smartglasses",
              deviceType: "even-realities",
            },
          ],
        }),
      });
    });

    await openAppPath(page, "/apps/hearwear");
    await expect(page.getByText("Facewear")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("1 device connected")).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByText("even-realities")).toBeVisible();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => facewearStatusRequests).toBeGreaterThan(1);
    await page.getByRole("button", { name: "Manage" }).click();
    await expect(page).toHaveURL(/\/apps\/smartglasses/);
    await expectNoIssues(page, issues.splice(0), "facewear device controls");

    await openAppPath(page, "/apps/smartglasses");
    await expect(
      page.getByRole("heading", { name: "Smartglasses" }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
    await expect(page.getByText("Bridge", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(
      page.getByText("Whole headset connected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Whole headset", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Run Check" }).click();
    await expect
      .poll(async () => (await readFixture(page))?.smartglasses.writes.length)
      .toBeGreaterThan(4);
    await expect(page.getByText("Requested serial/battery")).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Send Display" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Send Display" }).click();
    await expect(page.getByText(/Sent \d+ display page/).first()).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("Cleared display")).toBeVisible();

    await page.getByRole("button", { name: "Mic On" }).click();
    await expect(page.getByRole("button", { name: "Mic Off" })).toBeVisible();
    await expect
      .poll(async () =>
        (await readFixture(page))?.smartglasses.micStates.at(-1),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Mic Off" }).click();
    await expect
      .poll(async () =>
        (await readFixture(page))?.smartglasses.micStates.at(-1),
      )
      .toBe(false);

    await page.getByPlaceholder("SSID").fill("LabNet");
    await page.getByPlaceholder("Password").fill("correct horse");
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByText("Found 2 network(s)")).toBeVisible();
    await expect(page.getByText("DeviceRig")).toBeVisible();
    await page.getByRole("button", { name: "Refresh Wi-Fi Status" }).click();
    await expect(
      page.getByText("Connected to LabNet at 192.168.4.8"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Configure Wi-Fi" }).click();
    await expect(page.getByText("Credentials sent for LabNet")).toBeVisible();
    await expect
      .poll(async () =>
        (await readFixture(page))?.smartglasses.wifiCredentials.at(-1),
      )
      .toEqual({ ssid: "LabNet", password: "correct horse" });
    await page
      .getByRole("button", { name: /^(Native Setup|Native Wi-Fi Setup)$/ })
      .click();
    await expect(page.getByText("Native Wi-Fi setup requested")).toBeVisible();

    await page.getByRole("button", { name: "Android" }).click();
    await expect(page.getByText("Native bridge preferred")).toBeVisible();
    await expect(
      page.getByText("Use the host for pairing, Wi-Fi scan, and credentials."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Guided Validation" }).click();
    await expect(
      page.getByText("Tap and microphone validation requires").last(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy" }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as FixtureWindow).facewearSmartglassesReport?.connected,
        ),
      )
      .toBe(true);

    await expectNoIssues(
      page,
      issues.splice(0),
      "smartglasses bridge controls",
    );
  });
});
