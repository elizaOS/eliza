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

  globalObject[BOOT_CONFIG_WINDOW_KEY] = nextConfig;
  globalObject[LEGACY_BOOT_CONFIG_WINDOW_KEY] = nextConfig;
  globalObject[BOOT_CONFIG_STORE_KEY] = { current: nextConfig };
  return nextConfig;
}
