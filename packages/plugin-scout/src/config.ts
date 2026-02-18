export interface ScoutPluginConfig {
  apiUrl: string;
  apiKey: string;
  minServiceScore: number;
  autoRejectFlags: string[];
  cacheTtl: number;
  watchedDomains: string[];
  watchInterval: number;
}

export const DEFAULT_CONFIG: ScoutPluginConfig = {
  apiUrl: "https://scoutscore.ai",
  apiKey: "",
  minServiceScore: 50,
  autoRejectFlags: ["WALLET_SPAM_FARM", "TEMPLATE_SPAM", "ENDPOINT_DOWN"],
  cacheTtl: 30,
  watchedDomains: [],
  watchInterval: 60,
};

function str(val: string | boolean | number | null): string {
  if (val === null || val === undefined) return "";
  return String(val);
}

function intOrDefault(raw: string, fallback: number): number {
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(getSetting: (key: string) => string | boolean | number | null): ScoutPluginConfig {
  const autoRejectRaw = str(getSetting("SCOUT_AUTO_REJECT_FLAGS"));
  const autoRejectParsed = autoRejectRaw.split(",").map((f) => f.trim()).filter(Boolean);

  const rawApiUrl = str(getSetting("SCOUT_API_URL"));
  if (rawApiUrl && !rawApiUrl.startsWith("https://")) {
    throw new Error("SCOUT_API_URL must use HTTPS");
  }

  const watchInterval = intOrDefault(str(getSetting("SCOUT_WATCH_INTERVAL")), DEFAULT_CONFIG.watchInterval);

  return {
    apiUrl: rawApiUrl || DEFAULT_CONFIG.apiUrl,
    apiKey: str(getSetting("SCOUT_API_KEY")) || DEFAULT_CONFIG.apiKey,
    minServiceScore: intOrDefault(str(getSetting("SCOUT_MIN_SERVICE_SCORE")), DEFAULT_CONFIG.minServiceScore),
    autoRejectFlags: autoRejectParsed.length > 0 ? autoRejectParsed : DEFAULT_CONFIG.autoRejectFlags,
    cacheTtl: intOrDefault(str(getSetting("SCOUT_CACHE_TTL")), DEFAULT_CONFIG.cacheTtl),
    watchedDomains: str(getSetting("SCOUT_WATCHED_DOMAINS")).split(",").filter(Boolean).map((d) => d.trim()),
    watchInterval: Math.max(watchInterval, 1),
  };
}