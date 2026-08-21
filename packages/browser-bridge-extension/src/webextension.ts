/**
 * Promise-based facade over the raw `chrome.*` / `browser.*` extension APIs
 * (runtime messaging, storage, tabs, windows, alarms, scripting, permissions,
 * declarativeNetRequest). Every extension-API call in the package routes through
 * here so Chrome, Firefox, and Safari differences and callback-vs-promise quirks are
 * normalized in one place.
 */
import { withBrowserBridgeRequestTimeout } from "./request-timeout";

type Callback<T> = (value: T) => void;

type RawRuntime = {
  id?: string;
  lastError?: { message?: string };
  getManifest?: () => {
    version?: string;
    version_name?: string;
    permissions?: string[];
  };
  onInstalled?: {
    addListener: (listener: (details: { reason?: string }) => void) => void;
  };
  onStartup?: { addListener: (listener: () => void) => void };
  onMessage?: {
    addListener: (
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined,
    ) => void;
  };
  sendMessage?: (
    message: unknown,
    callback?: Callback<unknown>,
  ) => Promise<unknown> | undefined;
  sendNativeMessage?: (
    application: string,
    message: unknown,
    callback?: Callback<unknown>,
  ) => Promise<unknown> | undefined;
};

type RawStorageArea = {
  get?: (
    keys: string | string[] | Record<string, unknown> | null,
    callback?: Callback<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>> | undefined;
  set?: (
    values: Record<string, unknown>,
    callback?: Callback<void>,
  ) => Promise<void> | void;
  remove?: (
    keys: string | string[],
    callback?: Callback<void>,
  ) => Promise<void> | void;
};

type RawTabs = {
  query?: (
    queryInfo: Record<string, unknown>,
    callback?: Callback<unknown[]>,
  ) => Promise<unknown[]> | undefined;
  update?: (
    tabId: number,
    updateProperties: Record<string, unknown>,
    callback?: Callback<unknown>,
  ) => Promise<unknown> | undefined;
  create?: (
    createProperties: Record<string, unknown>,
    callback?: Callback<unknown>,
  ) => Promise<unknown> | undefined;
  reload?: (
    tabId: number,
    reloadProperties?: Record<string, unknown>,
    callback?: Callback<void>,
  ) => Promise<void> | void;
  sendMessage?: (
    tabId: number,
    message: unknown,
    options?: Record<string, unknown>,
    callback?: Callback<unknown>,
  ) => Promise<unknown> | undefined;
  onActivated?: {
    addListener: (listener: (info: unknown) => void) => void;
  };
  onUpdated?: {
    addListener: (
      listener: (tabId: number, changeInfo: unknown) => void,
    ) => void;
  };
  onRemoved?: {
    addListener: (listener: (tabId: number) => void) => void;
  };
};

type RawWindows = {
  getAll?: (
    getInfo: Record<string, unknown>,
    callback?: Callback<unknown[]>,
  ) => Promise<unknown[]> | undefined;
  update?: (
    windowId: number,
    updateInfo: Record<string, unknown>,
    callback?: Callback<unknown>,
  ) => Promise<unknown> | undefined;
  onFocusChanged?: {
    addListener: (listener: (windowId: number) => void) => void;
  };
};

type RawAlarms = {
  create?: (name: string, alarmInfo?: Record<string, unknown>) => void;
  clear?: (
    name: string,
    callback?: Callback<boolean>,
  ) => Promise<boolean> | undefined;
  onAlarm?: {
    addListener: (listener: (alarm: { name?: string }) => void) => void;
  };
};

type RawExtension = {
  isAllowedIncognitoAccess?: (
    callback?: Callback<boolean>,
  ) => Promise<boolean> | undefined;
};

type RawPermissions = {
  contains?: (
    permissions: Record<string, unknown>,
    callback?: Callback<boolean>,
  ) => Promise<boolean> | undefined;
  getAll?: (
    callback?: Callback<{
      permissions?: string[];
      origins?: string[];
    }>,
  ) =>
    | Promise<{
        permissions?: string[];
        origins?: string[];
      }>
    | undefined;
  request?: (
    permissions: Record<string, unknown>,
    callback?: Callback<boolean>,
  ) => Promise<boolean> | undefined;
};

type RawScriptingExecutionResult = {
  result?: unknown;
};

type RawScripting = {
  executeScript?: (
    injection:
      | {
          target: { tabId: number };
          world?: "ISOLATED" | "MAIN";
          func: (...args: unknown[]) => unknown;
          args?: unknown[];
        }
      | {
          target: { tabId: number };
          world?: "ISOLATED";
          files: string[];
        },
    callback?: Callback<RawScriptingExecutionResult[]>,
  ) => Promise<RawScriptingExecutionResult[]> | undefined;
};

type RawDeclarativeNetRequestRule = {
  id: number;
  priority: number;
  action: {
    type: string;
    redirect?: { url: string };
  };
  condition: {
    urlFilter?: string;
    resourceTypes?: string[];
  };
};

type RawDeclarativeNetRequest = {
  getDynamicRules?: (
    callback?: Callback<RawDeclarativeNetRequestRule[]>,
  ) => Promise<RawDeclarativeNetRequestRule[]> | undefined;
  updateDynamicRules?: (
    options: {
      removeRuleIds?: number[];
      addRules?: RawDeclarativeNetRequestRule[];
    },
    callback?: Callback<void>,
  ) => Promise<void> | void;
};

type RawApi = {
  runtime?: RawRuntime & {
    getURL?: (path: string) => string;
  };
  storage?: { local?: RawStorageArea };
  scripting?: RawScripting;
  tabs?: RawTabs;
  windows?: RawWindows;
  alarms?: RawAlarms;
  extension?: RawExtension;
  permissions?: RawPermissions;
  declarativeNetRequest?: RawDeclarativeNetRequest;
};

export type ExtensionTab = {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  incognito?: boolean;
  favIconUrl?: string;
};

export type ExtensionWindow = {
  id?: number;
  focused?: boolean;
  incognito?: boolean;
  tabs?: ExtensionTab[];
};

function getRawApi(): RawApi {
  const globalWithApi = globalThis as typeof globalThis & {
    browser?: RawApi;
    chrome?: RawApi;
  };
  const candidates = [globalWithApi.chrome, globalWithApi.browser].filter(
    (candidate): candidate is RawApi => Boolean(candidate),
  );
  const api =
    candidates.find(
      (candidate) =>
        Boolean(candidate.runtime?.sendMessage) ||
        Boolean(candidate.tabs?.query) ||
        Boolean(candidate.storage?.local?.get),
    ) ?? candidates[0];
  if (!api) {
    throw new Error("Browser extension API is unavailable.");
  }
  return api;
}

function getLastError(): string | null {
  const api = getRawApi();
  return api.runtime?.lastError?.message?.trim() ?? null;
}

function invokeAsync<T>(
  operation: string,
  call: (callback: Callback<T>) => Promise<T> | T | undefined | undefined,
): Promise<T> {
  return withBrowserBridgeRequestTimeout(operation, async () => {
    return await new Promise<T>((resolve, reject) => {
      try {
        const maybePromise = call((value) => {
          const errorMessage = getLastError();
          if (errorMessage) {
            reject(new Error(errorMessage));
            return;
          }
          resolve(value);
        });
        if (
          maybePromise &&
          typeof (maybePromise as Promise<T>).then === "function"
        ) {
          (maybePromise as Promise<T>).then(resolve, reject);
        }
      } catch (error) {
        // error-policy:J2 rethrow across the callback/promise shim boundary —
        // a synchronous throw from the browser API becomes the rejection the
        // awaiting caller already handles, with the original error intact.
        reject(error);
      }
    });
  });
}

export function getManifestVersion(): string {
  const manifest = getRawApi().runtime?.getManifest?.();
  const semverPattern =
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
  const versionName = manifest?.version_name?.trim() ?? "";
  if (semverPattern.test(versionName)) return versionName;
  const version = manifest?.version?.trim() ?? "";
  return semverPattern.test(version) ? version : "0.0.0";
}

export function getExtensionId(): string {
  const extensionId = getRawApi().runtime?.id?.trim();
  if (!extensionId) {
    throw new Error("runtime.id is unavailable");
  }
  return extensionId;
}

export function hasManifestPermission(permission: string): boolean {
  const permissions = getRawApi().runtime?.getManifest?.().permissions;
  return Array.isArray(permissions) && permissions.includes(permission);
}

export async function storageGet<T>(key: string): Promise<T | null> {
  const area = getRawApi().storage?.local;
  if (!area?.get) {
    throw new Error("storage.local.get is unavailable");
  }
  const values = await invokeAsync<Record<string, unknown>>(
    "storage.local.get",
    (callback) => area.get?.(key, callback),
  );
  return (values[key] as T | undefined) ?? null;
}

export async function storageSet(
  values: Record<string, unknown>,
): Promise<void> {
  const area = getRawApi().storage?.local;
  if (!area?.set) {
    throw new Error("storage.local.set is unavailable");
  }
  await invokeAsync<void>("storage.local.set", (callback) =>
    area.set?.(values, callback),
  );
}

export async function storageRemove(key: string): Promise<void> {
  const area = getRawApi().storage?.local;
  if (!area?.remove) {
    throw new Error("storage.local.remove is unavailable");
  }
  await invokeAsync<void>("storage.local.remove", (callback) =>
    area.remove?.(key, callback),
  );
}

export async function queryTabs(
  queryInfo: Record<string, unknown>,
): Promise<ExtensionTab[]> {
  const tabs = getRawApi().tabs;
  if (!tabs?.query) {
    return [];
  }
  const results = await invokeAsync<unknown[]>("tabs.query", (callback) =>
    tabs.query?.(queryInfo, callback),
  );
  return results as ExtensionTab[];
}

export async function getAllWindows(): Promise<ExtensionWindow[]> {
  const windows = getRawApi().windows;
  if (!windows?.getAll) {
    return [];
  }
  const results = await invokeAsync<unknown[]>("windows.getAll", (callback) =>
    windows.getAll?.({ populate: true }, callback),
  );
  return results as ExtensionWindow[];
}

export async function updateTab(
  tabId: number,
  updateProperties: Record<string, unknown>,
): Promise<ExtensionTab> {
  const tabs = getRawApi().tabs;
  if (!tabs?.update) {
    throw new Error("tabs.update is unavailable");
  }
  const result = await invokeAsync<unknown>("tabs.update", (callback) =>
    tabs.update?.(tabId, updateProperties, callback),
  );
  return result as ExtensionTab;
}

export async function createTab(
  createProperties: Record<string, unknown>,
): Promise<ExtensionTab> {
  const tabs = getRawApi().tabs;
  if (!tabs?.create) {
    throw new Error("tabs.create is unavailable");
  }
  const result = await invokeAsync<unknown>("tabs.create", (callback) =>
    tabs.create?.(createProperties, callback),
  );
  return result as ExtensionTab;
}

export async function reloadTab(tabId: number): Promise<void> {
  const tabs = getRawApi().tabs;
  if (!tabs?.reload) {
    return;
  }
  await invokeAsync<void>("tabs.reload", (callback) =>
    tabs.reload?.(tabId, {}, callback),
  );
}

export async function sendTabMessage<T>(
  tabId: number,
  message: unknown,
): Promise<T> {
  const tabs = getRawApi().tabs;
  if (!tabs?.sendMessage) {
    throw new Error("tabs.sendMessage is unavailable");
  }
  const result = await invokeAsync<unknown>("tabs.sendMessage", (callback) =>
    tabs.sendMessage?.(tabId, message, {}, callback),
  );
  return result as T;
}

export async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  const runtime = getRawApi().runtime;
  if (!runtime?.sendMessage) {
    throw new Error("runtime.sendMessage is unavailable");
  }
  const result = await invokeAsync<unknown>("runtime.sendMessage", (callback) =>
    runtime.sendMessage?.(message, callback),
  );
  return result as T;
}

/**
 * Sends one bounded request to a registered browser native-messaging host.
 * Protocol validation remains with the caller because the browser API treats
 * host responses as untrusted JSON.
 */
export async function sendNativeMessage<TRequest extends object, TResponse>(
  application: string,
  message: TRequest,
): Promise<TResponse> {
  const runtime = getRawApi().runtime;
  if (!runtime?.sendNativeMessage) {
    throw new Error("runtime.sendNativeMessage is unavailable");
  }
  const result = await invokeAsync<unknown>(
    "runtime.sendNativeMessage",
    (callback) => runtime.sendNativeMessage?.(application, message, callback),
  );
  return result as TResponse;
}

export async function executeScriptInMainWorld<T>(
  tabId: number,
  func: (...args: unknown[]) => T | Promise<T>,
  args: unknown[] = [],
): Promise<T> {
  const scripting = getRawApi().scripting;
  if (!scripting?.executeScript) {
    throw new Error("scripting.executeScript is unavailable");
  }
  const results = await invokeAsync<RawScriptingExecutionResult[]>(
    "scripting.executeScript",
    (callback) =>
      scripting.executeScript?.(
        {
          target: { tabId },
          world: "MAIN",
          func,
          args,
        },
        callback,
      ),
  );
  return results[0]?.result as T | undefined as T;
}

export async function executeContentScriptFiles(
  tabId: number,
  files: string[],
): Promise<void> {
  const scripting = getRawApi().scripting;
  if (!scripting?.executeScript) {
    throw new Error("scripting.executeScript is unavailable");
  }
  await invokeAsync<RawScriptingExecutionResult[]>(
    "scripting.executeScript",
    (callback) =>
      scripting.executeScript?.(
        {
          target: { tabId },
          world: "ISOLATED",
          files,
        },
        callback,
      ),
  );
}

/**
 * True only for a message sent from this extension's own privileged pages.
 * Browsers may host an installed guide or popup in a tab, so `tab` alone does
 * not distinguish it from a content script. A tab sender is privileged only
 * when its URL has this extension's origin; content scripts here run on
 * `http://localhost/*` at any port and therefore fail that check.
 */
export function isPrivilegedExtensionSender(sender: unknown): boolean {
  const extensionId = getRawApi().runtime?.id;
  if (!extensionId) return false;
  if (!sender || typeof sender !== "object") return false;
  const candidate = sender as { id?: unknown; tab?: unknown; url?: unknown };
  if (candidate.id !== extensionId) return false;
  if (candidate.tab === undefined) return true;
  if (typeof candidate.url !== "string") return false;
  const extensionUrl = getRawApi().runtime?.getURL?.("");
  if (!extensionUrl) return false;
  try {
    return new URL(candidate.url).origin === new URL(extensionUrl).origin;
  } catch {
    // error-policy:J3 A malformed sender URL is untrusted input.
    return false;
  }
}

export function addRuntimeMessageListener(
  listener: (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean | undefined,
): void {
  getRawApi().runtime?.onMessage?.addListener(listener);
}

export function addInstalledListener(
  listener: (details: { reason?: string }) => void,
): void {
  getRawApi().runtime?.onInstalled?.addListener(listener);
}

export function addStartupListener(listener: () => void): void {
  getRawApi().runtime?.onStartup?.addListener(listener);
}

export function addTabsActivatedListener(
  listener: (info: unknown) => void,
): void {
  getRawApi().tabs?.onActivated?.addListener(listener);
}

export function addTabsUpdatedListener(
  listener: (tabId: number, changeInfo: unknown) => void,
): void {
  getRawApi().tabs?.onUpdated?.addListener(listener);
}

export function addTabsRemovedListener(
  listener: (tabId: number) => void,
): void {
  getRawApi().tabs?.onRemoved?.addListener(listener);
}

export function addWindowFocusListener(
  listener: (windowId: number) => void,
): void {
  getRawApi().windows?.onFocusChanged?.addListener(listener);
}

export function createAlarm(name: string, periodInMinutes: number): void {
  getRawApi().alarms?.create?.(name, { periodInMinutes });
}

export function clearAlarm(name: string): void {
  getRawApi().alarms?.clear?.(name);
}

export function addAlarmListener(
  listener: (alarm: { name?: string }) => void,
): void {
  getRawApi().alarms?.onAlarm?.addListener(listener);
}

export async function isIncognitoAccessAllowed(): Promise<boolean> {
  const extension = getRawApi().extension;
  if (!extension?.isAllowedIncognitoAccess) {
    return false;
  }
  return await invokeAsync<boolean>(
    "extension.isAllowedIncognitoAccess",
    (callback) => extension.isAllowedIncognitoAccess?.(callback),
  );
}

export async function hasAllUrlHostPermission(): Promise<boolean> {
  const permissions = getRawApi().permissions;
  if (!permissions?.contains) {
    return false;
  }
  return await invokeAsync<boolean>("permissions.contains", (callback) =>
    permissions.contains?.(
      { origins: ["https://*/*", "http://*/*"] },
      callback,
    ),
  );
}

/**
 * Requests persistent access to normal HTTP(S) pages from a popup click.
 * Callers must invoke this directly inside a user-gesture handler; routing the
 * request through the background worker would lose the browser gesture token.
 */
export async function requestAllWebsiteAccess(): Promise<boolean> {
  const permissions = getRawApi().permissions;
  if (!permissions?.request) {
    throw new Error("permissions.request is unavailable");
  }
  return await invokeAsync<boolean>("permissions.request", (callback) =>
    permissions.request?.({ origins: ["https://*/*", "http://*/*"] }, callback),
  );
}

export async function getGrantedOrigins(): Promise<string[]> {
  const permissions = getRawApi().permissions;
  if (!permissions?.getAll) {
    return [];
  }
  const granted = await invokeAsync<{
    permissions?: string[];
    origins?: string[];
  }>("permissions.getAll", (callback) => permissions.getAll?.(callback));
  return Array.isArray(granted.origins)
    ? granted.origins
        .filter(
          (candidate): candidate is string => typeof candidate === "string",
        )
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0)
        .sort((left, right) => left.localeCompare(right))
    : [];
}

export async function focusWindow(windowId: number): Promise<void> {
  const windows = getRawApi().windows;
  if (!windows?.update) {
    return;
  }
  await invokeAsync<unknown>("windows.update", (callback) =>
    windows.update?.(windowId, { focused: true }, callback),
  );
}

export function getExtensionUrl(path: string): string {
  const runtime = getRawApi().runtime;
  if (!runtime?.getURL) {
    return path;
  }
  return runtime.getURL(path);
}

export type DeclarativeNetRequestRule = RawDeclarativeNetRequestRule;

export async function getDynamicRules(): Promise<
  RawDeclarativeNetRequestRule[]
> {
  const dnr = getRawApi().declarativeNetRequest;
  if (!dnr?.getDynamicRules) {
    return [];
  }
  return await invokeAsync<RawDeclarativeNetRequestRule[]>(
    "declarativeNetRequest.getDynamicRules",
    (callback) => dnr.getDynamicRules?.(callback),
  );
}

export async function updateDynamicRules(options: {
  removeRuleIds?: number[];
  addRules?: RawDeclarativeNetRequestRule[];
}): Promise<void> {
  const dnr = getRawApi().declarativeNetRequest;
  if (!dnr?.updateDynamicRules) {
    return;
  }
  await invokeAsync<void>(
    "declarativeNetRequest.updateDynamicRules",
    (callback) => dnr.updateDynamicRules?.(options, callback),
  );
}
