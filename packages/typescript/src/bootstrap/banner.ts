/**
 * Bootstrap Plugin Settings Banner
 * Beautiful ANSI art display for configuration on startup
 */

import type { IAgentRuntime } from "../types/index.ts";
import { logger } from "../logger.ts";

const c = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

interface SettingDisplay {
  name: string;
  value: string | undefined | null;
  isSecret?: boolean;
  defaultValue?: string;
  required?: boolean;
}

function formatSettingValue(setting: SettingDisplay): string {
  const isSet =
    setting.value !== undefined &&
    setting.value !== null &&
    setting.value !== "";
  const isDefault = !isSet && setting.defaultValue !== undefined;

  let displayValue: string;
  let statusColor: string;
  let statusText: string;

  if (isSet) {
    if (setting.isSecret) {
      displayValue = "***configured***";
    } else {
      displayValue = String(setting.value).substring(0, 28);
      if (String(setting.value).length > 28) displayValue += "...";
    }
    statusColor = c.green;
    statusText = "(set)";
  } else if (isDefault) {
    displayValue = setting.defaultValue!.substring(0, 28);
    statusColor = c.dim;
    statusText = "(default)";
  } else {
    displayValue = "not set";
    statusColor = setting.required ? c.red : c.dim;
    statusText = setting.required ? "(required!)" : "(optional)";
  }

  const nameCol = `${c.yellow}${setting.name.padEnd(28)}${c.reset}`;
  const valueCol = `${c.white}${displayValue.padEnd(26)}${c.reset}`;
  const statusCol = `${statusColor}${statusText}${c.reset}`;

  return `${c.dim}|${c.reset} ${nameCol}${c.dim}|${c.reset} ${valueCol}${statusCol}`;
}

export function printBootstrapBanner(runtime: IAgentRuntime): void {
  // Get settings - Bootstrap uses channel/source bypass and memory settings
  const alwaysRespondChannels = runtime.getSetting("ALWAYS_RESPOND_CHANNELS");
  const alwaysRespondSources = runtime.getSetting("ALWAYS_RESPOND_SOURCES");
  // Legacy names for backwards compatibility
  const bypassTypes = runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES");
  const bypassSources = runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES");
  const disableMemoryCreation = runtime.getSetting("DISABLE_MEMORY_CREATION");
  const allowMemorySourceIds = runtime.getSetting("ALLOW_MEMORY_SOURCE_IDS");

  const settings: SettingDisplay[] = [
    {
      name: "ALWAYS_RESPOND_CHANNELS",
      value: (alwaysRespondChannels || bypassTypes) as string,
    },
    {
      name: "ALWAYS_RESPOND_SOURCES",
      value: (alwaysRespondSources || bypassSources) as string,
    },
    {
      name: "DISABLE_MEMORY_CREATION",
      value:
        disableMemoryCreation != null
          ? String(disableMemoryCreation)
          : undefined,
    },
    {
      name: "ALLOW_MEMORY_SOURCE_IDS",
      value:
        allowMemorySourceIds != null ? String(allowMemorySourceIds) : undefined,
    },
  ];

  // Power/start symbol (right of "Bootstrap") — universal "on" / bootstrap = starting the system
  const sym = [
    "  ___  ",
    " |   | ",
    " | | | ",
    " |___| ",
    "   |   ",
    "   |   ",
  ].map((line) => `${c.yellow}${line}${c.reset}`);

  // Build each art line to exactly 78 visible chars (between the | borders)
  // The cyan text has backslashes that are real chars; we pad each to 78 total.
  const artLines = [
    //  text (visible chars counted)                                           sym (7)
    ["    ____              __       __                        ", sym[0]], // 56 + 7 = 63
    ["   / __ )____  ____  / /______/ /__________ _____       ", sym[1]], // 56 + 7 = 63
    ["  / __  / __ \\/ __ \\/ __/ ___/ __/ ___/ __ '/ __ \\     ", sym[2]], // 54 + 7 = 61
    [" / /_/ / /_/ / /_/ / /_(__  ) /_/ /  / /_/ / /_/ /     ", sym[3]], // 54 + 7 = 61
    ["/_____/\\____/\\____/\\__/____/\\__/_/   \\__,_/ .___/     ", sym[4]], // 51 + 7 = 58
    ["                                             \\__/     ", sym[5]], // 50 + 7 = 57
  ];

  const border = `${c.bright}${c.brightBlue}+${"-".repeat(78)}+${c.reset}`;
  const pipe = `${c.bright}${c.brightBlue}|${c.reset}`;

  function artLine(cyanText: string, symPart: string, suffix = ""): string {
    // Strip ANSI to count visible chars in symPart
    const symVisible = symPart.replace(/\x1b\[[0-9;]*m/g, "");
    const suffixVisible = suffix.replace(/\x1b\[[0-9;]*m/g, "");
    // Count visible chars of cyanText (backslashes in template literal are single chars at runtime)
    const cyanVisible = cyanText.length;
    const used = cyanVisible + symVisible.length + suffixVisible.length;
    const pad = Math.max(0, 78 - used);
    return `${pipe}${c.brightCyan}${cyanText}${c.reset}${symPart}${suffix}${" ".repeat(pad)}${pipe}`;
  }

  /*
   * Rendered preview (in terminal: border = bright blue, "Bootstrap" = bright cyan, symbol = yellow, "plugin" = dim).
   * To see it with colors from repo root: node packages/typescript/scripts/preview-banner.mjs
   *
   * +------------------------------------------------------------------------------+
   * |    ____              __       __                          ___                |
   * |   / __ )____  ____  / /______/ /__________ _____        |   |               |
   * |  / __  / __ \/ __ \/ __/ ___/ __/ ___/ __ '/ __ \      | | |               |
   * | / /_/ / /_/ / /_/ / /_(__  ) /_/ /  / /_/ / /_/ /      |___|               |
   * |/_____/\____/\____/\__/____/\__/_/   \__,_/ .___/          |                 |
   * |                                             \__/          |   plugin         |
   * +------------------------------------------------------------------------------+
   */
  const artContent = [
    artLine(artLines[0][0], artLines[0][1]),
    artLine(artLines[1][0], artLines[1][1]),
    artLine(artLines[2][0], artLines[2][1]),
    artLine(artLines[3][0], artLines[3][1]),
    artLine(artLines[4][0], artLines[4][1]),
    artLine(artLines[5][0], artLines[5][1], `${c.dim}plugin${c.reset}`),
  ].join("\n");

  const banner = `
${border}
${artContent}
${border}
${c.dim}|  Core agent: actions, evaluators, providers & event handlers                |${c.reset}
${c.bright}${c.brightBlue}+----------------------------+----------------------------+------------------+${c.reset}
${c.dim}| SETTING                    | VALUE                      | STATUS           |${c.reset}
${c.brightBlue}+----------------------------+----------------------------+------------------+${c.reset}
${settings.map((s) => formatSettingValue(s)).join("\n")}
${c.brightBlue}+------------------------------------------------------------------------------+${c.reset}
${c.dim}| To configure: Add settings to your .env file or character settings          |${c.reset}
${c.dim}| Channel/source lists: JSON arrays like '["DM", "VOICE_DM"]'                  |${c.reset}
${c.brightBlue}+------------------------------------------------------------------------------+${c.reset}
`;

  logger.info(`\n${banner}\n`);
}
