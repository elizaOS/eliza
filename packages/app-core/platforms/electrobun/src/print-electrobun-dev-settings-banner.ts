import { colorizeDevSettingsStartupBanner } from "@elizaos/shared/dev-settings-banner-style";
import { prependDevSubsystemFigletHeading } from "@elizaos/shared/dev-settings-figlet-heading";
import {
  type DevSettingsRow,
  formatDevSettingsTable,
} from "@elizaos/shared/dev-settings-table";
import {
  firstWinningEnvString,
  resolveDesktopApiPortPreference,
} from "@elizaos/shared/runtime-env";
import { resolveDesktopRuntimeMode } from "./api-base";
import { resolveMainWindowPartition } from "./main-window-session";

function shouldPrintElectrobunDevSettingsBanner(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.ELECTROBUN_DEV) return true;
  if (process.env.NODE_ENV === "production") return false;
  const dir = import.meta.dir.replace(/\\/g, "/");
  return dir.includes("/electrobun/src/");
}

/**
 * Electrobun main process — env reads for desktop dev (printed once at startup).
 */
export function printElectrobunDevSettingsBanner(
  env: Record<string, string | undefined>,
): void {
  if (!shouldPrintElectrobunDevSettingsBanner()) return;

  const runtime = resolveDesktopRuntimeMode(env);
  const apiPref = resolveDesktopApiPortPreference(env);
  const partition = resolveMainWindowPartition(env);

  const rendererWin = firstWinningEnvString(env, [
    "MILADY_RENDERER_URL",
    "VITE_DEV_SERVER_URL",
  ]);

  const browserPort = env.MILADY_BROWSER_WORKSPACE_PORT?.trim();
  const browserTok = env.MILADY_BROWSER_WORKSPACE_TOKEN?.trim();

  const shotOpt = env.MILADY_DESKTOP_SCREENSHOT_SERVER?.trim().toLowerCase();
  const screenshotOff =
    shotOpt === "0" ||
    shotOpt === "false" ||
    shotOpt === "no" ||
    shotOpt === "off";

  const rows: DevSettingsRow[] = [
    {
      setting: "desktopRuntimeMode",
      effective: runtime.mode,
      source:
        runtime.mode === "external" && runtime.externalApi.source
          ? `env set — ${runtime.externalApi.source}`
          : runtime.mode === "disabled"
            ? "env set — MILADY_DESKTOP_SKIP_EMBEDDED_AGENT"
            : "default (local embedded agent)",
      change:
        "set MILADY_DESKTOP_TEST_API_BASE / MILADY_DESKTOP_API_BASE / MILADY_API_BASE_URL / MILADY_API_BASE for external; MILADY_DESKTOP_SKIP_EMBEDDED_AGENT=1 for disabled",
    },
    {
      setting: "MILADY_RENDERER_URL / VITE_DEV_SERVER_URL",
      effective: rendererWin?.value ?? "—",
      source: rendererWin
        ? `env set — ${rendererWin.key}`
        : "default (unset — static dist)",
      change:
        "export MILADY_RENDERER_URL=http://127.0.0.1:<vite>/ (or VITE_DEV_SERVER_URL)",
    },
    {
      setting: "API port (preference)",
      effective: String(apiPref.port),
      source: apiPref.sourceLabel,
      change: apiPref.changeLabel,
    },
    {
      setting: "MILADY_DESKTOP_TEST_PARTITION",
      effective: env.MILADY_DESKTOP_TEST_PARTITION?.trim() || "—",
      source: env.MILADY_DESKTOP_TEST_PARTITION?.trim()
        ? "env set — MILADY_DESKTOP_TEST_PARTITION"
        : "default (unset)",
      change: "export MILADY_DESKTOP_TEST_PARTITION=<id> for test profile",
    },
    {
      setting: "MILADY_DESKTOP_TEST_API_BASE",
      effective: env.MILADY_DESKTOP_TEST_API_BASE?.trim() || "—",
      source: env.MILADY_DESKTOP_TEST_API_BASE?.trim()
        ? "env set — MILADY_DESKTOP_TEST_API_BASE"
        : "default (unset)",
      change:
        "export MILADY_DESKTOP_TEST_API_BASE=https://… for partition tests",
    },
    {
      setting: "resolveMainWindowPartition",
      effective: partition ?? "—",
      source: "derived — main-window-session.ts",
      change:
        "export MILADY_DESKTOP_TEST_PARTITION or MILADY_DESKTOP_TEST_API_BASE (see source)",
    },
    {
      setting: "MILADY_BROWSER_WORKSPACE_PORT",
      effective: browserPort || "—",
      source: browserPort
        ? "env set — MILADY_BROWSER_WORKSPACE_PORT"
        : "default (unset)",
      change: "export MILADY_BROWSER_WORKSPACE_PORT=<port>",
    },
    {
      setting: "MILADY_BROWSER_WORKSPACE_TOKEN",
      effective: browserTok ? "set (redacted)" : "—",
      source: browserTok
        ? "env set — MILADY_BROWSER_WORKSPACE_TOKEN"
        : "default (unset)",
      change: "export MILADY_BROWSER_WORKSPACE_TOKEN=<secret> or unset",
    },
    {
      setting: "MILADY_DESKTOP_SCREENSHOT_SERVER",
      effective: screenshotOff ? "off" : "on",
      source: screenshotOff
        ? "env set — opt-out (0/false/no/off)"
        : "default (on)",
      change:
        "export MILADY_DESKTOP_SCREENSHOT_SERVER=0 to disable; MILADY_SCREENSHOT_SERVER_PORT for port",
    },
    {
      setting: "NODE_ENV",
      effective: env.NODE_ENV ?? "—",
      source: env.NODE_ENV ? "env set — NODE_ENV" : "default (unset)",
      change: "export NODE_ENV=development|production",
    },
  ];

  console.log(
    colorizeDevSettingsStartupBanner(
      prependDevSubsystemFigletHeading(
        "electrobun",
        formatDevSettingsTable("Electrobun shell — effective settings", rows),
      ),
    ),
  );
}
