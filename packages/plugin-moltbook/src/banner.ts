/**
 * Moltbook Plugin Banner
 *
 * Beautiful ASCII art banner for plugin initialization display.
 */

import type { IAgentRuntime } from "@elizaos/core";

// Moltbook theme - social/community vibes
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Primary - warm amber
  primary: "\x1b[33m",
  // Secondary - soft purple
  secondary: "\x1b[35m",
  // Accent - cyan
  accent: "\x1b[36m",
  brightGreen: "\x1b[92m",
  brightWhite: "\x1b[97m",
  brightRed: "\x1b[91m",
  brightBlue: "\x1b[94m",
};

export interface PluginSetting {
  name: string;
  value: unknown;
  defaultValue?: unknown;
  sensitive?: boolean;
  required?: boolean;
}

export interface BannerOptions {
  runtime: IAgentRuntime;
  settings?: PluginSetting[];
}

function mask(v: string): string {
  if (!v || v.length < 8) return "••••••••";
  return `${v.slice(0, 4)}${"•".repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}

function fmtVal(value: unknown, sensitive: boolean, maxLen: number): string {
  let s: string;
  if (value === undefined || value === null || value === "") {
    s = "(not set)";
  } else if (sensitive) {
    s = mask(String(value));
  } else {
    s = String(value);
  }
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 3)}...`;
  return s;
}

function isDef(v: unknown, d: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return d !== undefined && v === d;
}

function pad(s: string, n: number): string {
  const len = stripAnsiColorCodes(s).length;
  if (len >= n) return s;
  return s + " ".repeat(n - len);
}

function line(content: string): string {
  const stripped = stripAnsiColorCodes(content);
  const len = stripped.length;
  if (len > 78) return content.slice(0, 78);
  return content + " ".repeat(78 - len);
}

function stripAnsiColorCodes(input: string): string {
  let output = "";
  let i = 0;

  while (i < input.length) {
    if (input.charCodeAt(i) === 27 && input[i + 1] === "[") {
      i += 2;
      while (i < input.length && input[i] !== "m") {
        i++;
      }
      if (i < input.length) {
        i++;
      }
      continue;
    }

    output += input[i];
    i++;
  }

  return output;
}

export function printBanner(options: BannerOptions): void {
  const { runtime, settings } = options;
  const R = ANSI.reset,
    D = ANSI.dim,
    B = ANSI.bold;
  const c1 = ANSI.primary,
    c2 = ANSI.secondary,
    c3 = ANSI.accent;

  const top = `${c1}╔${"═".repeat(78)}╗${R}`;
  const mid = `${c1}╠${"═".repeat(78)}╣${R}`;
  const bot = `${c1}╚${"═".repeat(78)}╝${R}`;
  const row = (s: string) => `${c1}║${R}${line(s)}${c1}║${R}`;

  const lines: string[] = [""];
  lines.push(top);
  lines.push(row(` ${B}Character: ${runtime.character.name}${R}`));
  lines.push(mid);

  // Moltbook ASCII Art - Community/Social theme
  lines.push(row(`${c2}   __  __       _ _   _                 _    ${c3}   .--.${R}`));
  lines.push(row(`${c2}  |  \\/  | ___ | | |_| |__   ___   ___ | | __${c3}  /    \\${R}`));
  lines.push(row(`${c2}  | |\\/| |/ _ \\| | __| '_ \\ / _ \\ / _ \\| |/ /${c3} ( o  o )${R}`));
  lines.push(row(`${c2}  | |  | | (_) | | |_| |_) | (_) | (_) |   < ${c3}  \\    /${R}`));
  lines.push(row(`${c2}  |_|  |_|\\___/|_|\\__|_.__/ \\___/ \\___/|_|\\_\\${c3}   '--'${R}`));
  lines.push(row(``));
  lines.push(row(`${D}         Social Network for AI Agents - Community Participation${R}`));
  lines.push(mid);

  if (settings && settings.length > 0) {
    const NW = 32,
      VW = 28,
      SW = 8;
    lines.push(row(` ${B}${pad("ENV VARIABLE", NW)} ${pad("VALUE", VW)} ${pad("STATUS", SW)}${R}`));
    lines.push(row(` ${D}${"-".repeat(NW)} ${"-".repeat(VW)} ${"-".repeat(SW)}${R}`));

    for (const s of settings) {
      const def = isDef(s.value, s.defaultValue);
      const set = s.value !== undefined && s.value !== null && s.value !== "";

      let ico: string, st: string;
      if (!set && s.required) {
        ico = `${ANSI.brightRed}*${R}`;
        st = `${ANSI.brightRed}REQUIRED${R}`;
      } else if (!set) {
        ico = `${D}o${R}`;
        st = `${D}default${R}`;
      } else if (def) {
        ico = `${ANSI.brightBlue}o${R}`;
        st = `${ANSI.brightBlue}default${R}`;
      } else {
        ico = `${ANSI.brightGreen}+${R}`;
        st = `${ANSI.brightGreen}custom${R}`;
      }

      const name = pad(s.name, NW - 2);
      const val = pad(fmtVal(s.value ?? s.defaultValue, s.sensitive ?? false, VW), VW);
      const status = pad(st, SW);
      lines.push(row(` ${ico} ${c2}${name}${R} ${val} ${status}`));
    }
    lines.push(mid);
  }

  // Features
  lines.push(row(` ${B}${ANSI.brightWhite}Features${R}`));
  lines.push(row(` ${ANSI.brightGreen}~${R} Automatic account registration and claiming`));
  lines.push(row(` ${ANSI.brightGreen}~${R} Post, comment, and vote on Moltbook`));
  lines.push(row(` ${ANSI.brightGreen}~${R} Follow other moltys and browse feeds`));
  lines.push(row(` ${ANSI.brightGreen}~${R} Semantic search across the community`));
  lines.push(row(` ${ANSI.brightGreen}~${R} Quality-gated autonomous posting`));
  lines.push(bot);
  lines.push("");

  runtime.logger.info(lines.join("\n"));
}
