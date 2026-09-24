/** Keeps native endpoint updates separate from the renderer-selected connection. */
export const ELECTROBUN_BOOT_CONFIG_STORE_KEY = Symbol.for(
  "elizaos.app.boot-config",
);
const BOOT_CONFIG_STORE_KEY = ELECTROBUN_BOOT_CONFIG_STORE_KEY;
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
const LEGACY_BOOT_CONFIG_WINDOW_KEY = "__ELIZA_APP_BOOT_CONFIG__";

export type ElectrobunBootConfig = {
  apiBase?: string;
  apiToken?: string;
  [key: string]: unknown;
};

type ElectrobunBootConfigStore = {
  current: ElectrobunBootConfig;
};

export type ElectrobunBootConfigWindow = {
  [BOOT_CONFIG_WINDOW_KEY]?: ElectrobunBootConfig;
  [LEGACY_BOOT_CONFIG_WINDOW_KEY]?: ElectrobunBootConfig;
  [BOOT_CONFIG_STORE_KEY]?: ElectrobunBootConfigStore;
};

declare global {
  interface Window {
    [BOOT_CONFIG_WINDOW_KEY]?: ElectrobunBootConfig;
    [LEGACY_BOOT_CONFIG_WINDOW_KEY]?: ElectrobunBootConfig;
    [BOOT_CONFIG_STORE_KEY]?: ElectrobunBootConfigStore;
  }
}

export function updateElectrobunBootConfig(
  globalObject: ElectrobunBootConfigWindow,
  updates: Pick<ElectrobunBootConfig, "apiBase" | "apiToken">,
): ElectrobunBootConfig {
  const currentConfig =
    globalObject[BOOT_CONFIG_WINDOW_KEY] ??
    globalObject[LEGACY_BOOT_CONFIG_WINDOW_KEY] ??
    globalObject[BOOT_CONFIG_STORE_KEY]?.current ??
    {};
  const nextConfig = {
    ...currentConfig,
    ...updates,
  };

  if (Object.hasOwn(updates, "apiToken") && updates.apiToken === undefined) {
    delete nextConfig.apiToken;
  }
  globalObject[BOOT_CONFIG_WINDOW_KEY] = nextConfig;
  globalObject[LEGACY_BOOT_CONFIG_WINDOW_KEY] = nextConfig;
  globalObject[BOOT_CONFIG_STORE_KEY] = { current: nextConfig };
  return nextConfig;
}

/** Native messages may rotate their own endpoint, never a selected foreign host. */
export function applyElectrobunApiBaseUpdate(
  globalObject: ElectrobunBootConfigWindow & {
    __ELIZA_DESKTOP_LOCAL_API_BASE__?: string;
    __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: string;
    dispatchEvent?: (event: Event) => boolean;
  },
  update: {
    base: string;
    token?: string;
    localApiBase?: string | null;
    externalApiBase?: string | null;
  },
): void {
  const previousBase = normalizeNativeApiBase(
    globalObject.__ELIZA_DESKTOP_LOCAL_API_BASE__ ??
      globalObject.__ELIZA_DESKTOP_EXTERNAL_API_BASE__,
  );
  const currentConfig =
    globalObject[BOOT_CONFIG_STORE_KEY]?.current ??
    globalObject[BOOT_CONFIG_WINDOW_KEY] ??
    globalObject[LEGACY_BOOT_CONFIG_WINDOW_KEY];
  const selectedBase = normalizeNativeApiBase(currentConfig?.apiBase);
  const nextBase = normalizeNativeApiBase(update.base);
  for (const [key, value] of [
    ["__ELIZA_DESKTOP_LOCAL_API_BASE__", update.localApiBase],
    ["__ELIZA_DESKTOP_EXTERNAL_API_BASE__", update.externalApiBase],
  ] as const) {
    const normalized = normalizeNativeApiBase(value);
    if (normalized) globalObject[key] = normalized;
    else Reflect.deleteProperty(globalObject, key);
  }
  if (
    !nextBase ||
    (currentConfig?.apiBase &&
      (previousBase === null || selectedBase !== previousBase))
  )
    return;
  if (
    selectedBase === nextBase &&
    (currentConfig?.apiToken?.trim() || undefined) ===
      (update.token?.trim() || undefined)
  )
    return;
  updateElectrobunBootConfig(globalObject, {
    apiBase: nextBase,
    apiToken: update.token?.trim() || undefined,
  });
  globalObject.dispatchEvent?.(
    new CustomEvent("eliza:desktop-api-base-updated", {
      detail: { previousBase, base: nextBase },
    }),
  );
}

function normalizeNativeApiBase(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    // error-policy:J3 invalid native bindings cannot authorize a selected-host update.
    return null;
  }
}
