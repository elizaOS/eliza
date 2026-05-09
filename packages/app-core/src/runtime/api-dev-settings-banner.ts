import process from "node:process";
import {
  type DevSettingsRow,
  ELIZA_RUNTIME_ENV_KEYS,
  firstWinningEnvString,
  formatDevSettingsTable,
  resolveApiSecurityConfig,
  resolveApiToken,
} from "@elizaos/shared";
import { prependDevSubsystemFigletHeading } from "@elizaos/shared";

function summarizeList(label: string, items: string[], maxLen: number): string {
  if (items.length === 0) return `${label}: (empty)`;
  const joined = items.join(", ");
  if (joined.length <= maxLen) return `${label}: ${joined}`;
  return `${label}: ${joined.slice(0, maxLen - 1)}…`;
}

/**
 * After `startApiServer` resolves — uses actual listen port and post-start env (token may be generated).
 */
export function formatApiDevSettingsBannerText(
  actualPort: number,
  options?: { hadUserApiTokenInEnv: boolean },
): string {
  const env = process.env as Record<string, string | undefined>;
  const sec = resolveApiSecurityConfig(env);
  const token = resolveApiToken(env);
  const hadUser = options?.hadUserApiTokenInEnv ?? false;

  const bindWin = firstWinningEnvString(env, ELIZA_RUNTIME_ENV_KEYS.apiBind);
  const originsWin = firstWinningEnvString(
    env,
    ELIZA_RUNTIME_ENV_KEYS.allowedOrigins,
  );
  const hostsWin = firstWinningEnvString(
    env,
    ELIZA_RUNTIME_ENV_KEYS.allowedHosts,
  );

  const rows: DevSettingsRow[] = [
    {
      setting: "Listen (actual)",
      effective: `${sec.bindHost}:${actualPort}`,
      source: "derived — process bound",
      change:
        "set ELIZA_API_BIND / ELIZA_API_BIND and ELIZA_API_PORT / ELIZA_* before start",
    },
    {
      setting: "ELIZA_API_BIND / ELIZA_API_BIND",
      effective: sec.bindHost,
      source: bindWin
        ? `env set — ${bindWin.key}=${bindWin.value}`
        : `default (unset — ${sec.bindHost})`,
      change: "export ELIZA_API_BIND=127.0.0.1; unset both for default",
    },
    {
      setting: "ELIZA_API_TOKEN / ELIZA_API_TOKEN",
      effective: token ? "set (redacted)" : "unset",
      source: token
        ? hadUser
          ? `env set — ${firstWinningEnvString(env, ELIZA_RUNTIME_ENV_KEYS.apiToken)?.key ?? "ELIZA_API_TOKEN"}`
          : "generated — non-loopback or cloud (ensureApiTokenForBindHost)"
        : "default (unset — loopback dev)",
      change:
        "export ELIZA_API_TOKEN=<secret> or unset; ELIZA_DISABLE_AUTO_API_TOKEN=1 disables auto token",
    },
    {
      setting: "ELIZA_ALLOWED_ORIGINS / CORS",
      effective: summarizeList("origins", sec.allowedOrigins, 40),
      source: originsWin
        ? `env set — ${originsWin.key}`
        : "default (unset — empty list)",
      change:
        "export ELIZA_ALLOWED_ORIGINS=a,b (or ELIZA_ALLOWED_ORIGINS, CORS_ORIGINS)",
    },
    {
      setting: "ELIZA_ALLOWED_HOSTS",
      effective: summarizeList("hosts", sec.allowedHosts, 40),
      source: hostsWin
        ? `env set — ${hostsWin.key}`
        : "default (unset — empty list)",
      change: "export ELIZA_ALLOWED_HOSTS=host1,host2",
    },
    {
      setting: "ELIZA_ALLOW_NULL_ORIGIN / ELIZA_ALLOW_NULL_ORIGIN",
      effective: sec.allowNullOrigin ? "on" : "off",
      source: sec.allowNullOrigin
        ? "env set — flag enabled"
        : "default (unset — off)",
      change: "export ELIZA_ALLOW_NULL_ORIGIN=1 to allow; unset to default off",
    },
    {
      setting: "ELIZA_DISABLE_AUTO_API_TOKEN",
      effective: sec.disableAutoApiToken ? "on" : "off",
      source: sec.disableAutoApiToken
        ? "env set — flag enabled"
        : "default (unset — off)",
      change: "export ELIZA_DISABLE_AUTO_API_TOKEN=1 to skip auto token",
    },
    {
      setting: "ELIZA_RENDERER_URL",
      effective: env.ELIZA_RENDERER_URL?.trim() || "—",
      source: env.ELIZA_RENDERER_URL?.trim()
        ? "env set — ELIZA_RENDERER_URL"
        : "default (unset)",
      change:
        "export ELIZA_RENDERER_URL=http://127.0.0.1:<vite>/ (desktop dev)",
    },
    {
      setting: "ELIZA_DESKTOP_DEV_LOG_PATH",
      effective: env.ELIZA_DESKTOP_DEV_LOG_PATH?.trim() || "—",
      source: env.ELIZA_DESKTOP_DEV_LOG_PATH?.trim()
        ? "env set — orchestrator forwarded"
        : "default (unset)",
      change:
        "set by dev orchestrator; GET /api/dev/console-log tails this file",
    },
    {
      setting: "Dev hooks",
      effective:
        "/api/dev/stack, /api/dev/console-log, /api/dev/cursor-screenshot",
      source: "derived — dev server",
      change: `GET http://127.0.0.1:${actualPort}/api/dev/stack etc.; docs/apps/desktop-local-development.md`,
    },
  ];

  return prependDevSubsystemFigletHeading(
    "api",
    formatDevSettingsTable("API — effective settings (after listen)", rows),
  );
}
