type Callback<T> = (value: T) => void;

type RawRuntime = {
  lastError?: { message?: string };
  getManifest?: () => { version?: string };
  onInstalled?: { addListener: (listener: () => void) => void };
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
};

type RawScriptingExecutionResult = {
  result?: unknown;
};

type RawScripting = {
  executeScript?: (
    injection: {
      target: { tabId: number };
      world?: "ISOLATED" | "MAIN";
      func: (...args: unknown[]) => unknown;
      args?: unknown[];
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
  call: (callback: Callback<T>) => Promise<T> | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      const maybePromise = call((value) => {
        const errorMessage = getLastError();
        if (errorMessage) {
          reject(new Error(errorMessage));
          return;
        }
        resolve(value);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

export function getManifestVersion(): string {
  return getRawApi().runtime?.getManifest?.().version ?? "0.0.0";
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
  const values = await invokeAsync<Record<string, unknown>>((callback) =>
    area.get?.(key, callback),
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
  await invokeAsync<void>((callback) => area.set?.(values, callback));
}

export async function storageRemove(key: string): Promise<void> {
  const area = getRawApi().storage?.local;
  if (!area?.remove) {
    throw new Error("storage.local.remove is unavailable");
  }
  await invokeAsync<void>((callback) => area.remove?.(key, callback));
}

export async function queryTabs(
  queryInfo: Record<string, unknown>,
): Promise<ExtensionTab[]> {
  const tabs = getRawApi().tabs;
  if (!tabs?.query) {
    return [];
  }
  const results = await invokeAsync<unknown[]>((callback) =>
    tabs.query?.(queryInfo, callback),
  );
  return results as ExtensionTab[];
}

export async function getAllWindows(): Promise<ExtensionWindow[]> {
  const windows = getRawApi().windows;
  if (!windows?.getAll) {
    return [];
  }
  const results = await invokeAsync<unknown[]>((callback) =>
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
  const result = await invokeAsync<unknown>((callback) =>
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
  const result = await invokeAsync<unknown>((callback) =>
    tabs.create?.(createProperties, callback),
  );
  return result as ExtensionTab;
}

export async function reloadTab(tabId: number): Promise<void> {
  const tabs = getRawApi().tabs;
  if (!tabs?.reload) {
    return;
  }
  await invokeAsync<void>((callback) => tabs.reload?.(tabId, {}, callback));
}

export async function sendTabMessage<T>(
  tabId: number,
  message: unknown,
): Promise<T> {
  const tabs = getRawApi().tabs;
  if (!tabs?.sendMessage) {
    throw new Error("tabs.sendMessage is unavailable");
  }
  const result = await invokeAsync<unknown>((callback) =>
    tabs.sendMessage?.(tabId, message, {}, callback),
  );
  return result as T;
}

export async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  const runtime = getRawApi().runtime;
  if (!runtime?.sendMessage) {
    throw new Error("runtime.sendMessage is unavailable");
  }
  const result = await invokeAsync<unknown>((callback) =>
    runtime.sendMessage?.(message, callback),
  );
  return result as T;
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
  const results = await invokeAsync<RawScriptingExecutionResult[]>((callback) =>
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

export function addRuntimeMessageListener(
  listener: (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean | undefined,
): void {
  getRawApi().runtime?.onMessage?.addListener(listener);
}

export function addInstalledListener(listener: () => void): void {
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
  return await invokeAsync<boolean>((callback) =>
    extension.isAllowedIncognitoAccess?.(callback),
  );
}

export async function hasAllUrlHostPermission(): Promise<boolean> {
  const permissions = getRawApi().permissions;
  if (!permissions?.contains) {
    return false;
  }
  return await invokeAsync<boolean>((callback) =>
    permissions.contains?.({ origins: ["<all_urls>"] }, callback),
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
  }>((callback) => permissions.getAll?.(callback));
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
  await invokeAsync<unknown>((callback) =>
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
  return await invokeAsync<RawDeclarativeNetRequestRule[]>((callback) =>
    dnr.getDynamicRules?.(callback),
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
  await invokeAsync<void>((callback) =>
    dnr.updateDynamicRules?.(options, callback),
  );
}
