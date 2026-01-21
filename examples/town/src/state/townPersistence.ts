import {
  defaultModelSettings,
  type ModelProvider,
  type ModelSettings,
  type ProviderModelConfig,
} from "../runtime/modelSettings";
import type { TownSimulationSnapshot } from "../simulation/townSimulation";

type SettingsSnapshot = {
  version: 1;
  settings: ModelSettings;
};

type ProviderSettingsSnapshot = {
  version: 1;
  provider: ModelProvider;
  config: ProviderModelConfig;
};

const SETTINGS_KEY = "ai-town:settings";
const SNAPSHOT_KEY = "ai-town:snapshot";
const RUNNING_KEY = "ai-town:running";
const PROVIDER_SETTINGS_KEY_PREFIX = "ai-town:settings:provider:";
const PROVIDERS: ModelProvider[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "xai",
  "local",
];

function readFromStorage<T>(key: string): T | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  const raw = localStorage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeToStorage<T>(key: string, value: T): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadModelSettings(): Promise<ModelSettings | null> {
  const cached = readFromStorage<SettingsSnapshot>(SETTINGS_KEY);
  const providerOverrides = readProviderSettings();
  let settings = cached && cached.version === 1 ? cached.settings : null;

  if (!settings && providerOverrides.size > 0) {
    settings = defaultModelSettings();
  }

  if (!settings) {
    return Promise.resolve(null);
  }

  for (const [provider, config] of providerOverrides.entries()) {
    settings = {
      ...settings,
      [provider]: {
        ...settings[provider],
        ...config,
      },
    };
  }

  return Promise.resolve(settings);
}

export function saveModelSettings(settings: ModelSettings): Promise<void> {
  const snapshot: SettingsSnapshot = { version: 1, settings };
  writeToStorage(SETTINGS_KEY, snapshot);
  for (const provider of PROVIDERS) {
    const providerSnapshot: ProviderSettingsSnapshot = {
      version: 1,
      provider,
      config: settings[provider],
    };
    writeToStorage(getProviderSettingsKey(provider), providerSnapshot);
  }
  return Promise.resolve();
}

export function loadTownSnapshot(): Promise<TownSimulationSnapshot | null> {
  const cached = readFromStorage<TownSimulationSnapshot>(SNAPSHOT_KEY);
  if (!cached || cached.version !== 1) {
    return Promise.resolve(null);
  }
  return Promise.resolve(cached);
}

export function saveTownSnapshot(
  snapshot: TownSimulationSnapshot,
): Promise<void> {
  writeToStorage(SNAPSHOT_KEY, snapshot);
  return Promise.resolve();
}

export function loadRunningState(): boolean {
  const cached = readFromStorage<{ running: boolean }>(RUNNING_KEY);
  return cached?.running ?? false;
}

export function saveRunningState(running: boolean): void {
  writeToStorage(RUNNING_KEY, { running });
}

export function clearTownState(): Promise<void> {
  if (typeof localStorage === "undefined") {
    return Promise.resolve();
  }
  const keysToKeep = new Set<string>([
    SETTINGS_KEY,
    ...PROVIDERS.map((provider) => getProviderSettingsKey(provider)),
  ]);
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) {
      continue;
    }
    if (key.startsWith("ai-town:") && !keysToKeep.has(key)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
  return Promise.resolve();
}

function getProviderSettingsKey(provider: ModelProvider): string {
  return `${PROVIDER_SETTINGS_KEY_PREFIX}${provider}`;
}

function readProviderSettings(): Map<ModelProvider, ProviderModelConfig> {
  const results = new Map<ModelProvider, ProviderModelConfig>();
  for (const provider of PROVIDERS) {
    const cached = readFromStorage<ProviderSettingsSnapshot>(
      getProviderSettingsKey(provider),
    );
    if (cached && cached.version === 1) {
      results.set(provider, cached.config);
    }
  }
  return results;
}
