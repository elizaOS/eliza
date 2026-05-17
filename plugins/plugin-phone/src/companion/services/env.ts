/**
 * Runtime environment for the phone-companion views.
 *
 * Values come from Vite's `import.meta.env`. Missing or empty configuration is
 * represented explicitly: `agentUrl()` returns `null` and `apnsEnabled()`
 * returns `false` rather than throwing, so callers can branch without try/catch.
 */

interface ViteEnv {
  VITE_ELIZA_AGENT_URL?: string;
  VITE_ELIZA_APNS_ENABLED?: string;
  VITE_ELIZA_LOG_LEVEL?: string;
  MODE?: string;
}

function readEnv(): ViteEnv {
  const meta = import.meta as { env?: ViteEnv };
  return meta.env ?? {};
}

export function agentUrl(): string | null {
  const raw = readEnv().VITE_ELIZA_AGENT_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function apnsEnabled(): boolean {
  return readEnv().VITE_ELIZA_APNS_ENABLED === "1";
}

export function isDev(): boolean {
  return readEnv().MODE !== "production";
}
