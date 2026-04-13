import { DEFAULT_CONFIG, type AppConfig } from "./types";

const CONFIG_KEY = "eliza:tauri-config";

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return JSON.parse(raw) as AppConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

