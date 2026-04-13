/**
 * Optional ANSI styling for dev settings banners (orchestrator, Vite, API, Electrobun).
 * Plain tables live in `dev-settings-table.ts`; this only wraps box lines for terminals.
 * Figlet headings use a separate color; use `colorizeDevSettingsStartupBanner` when a
 * heading is prepended above the framed table.
 */

const RESET = "\x1b[0m";
const BOLD_CYAN = "\x1b[1;36m";
const DIM_CYAN = "\x1b[2;36m";
const BOLD_MAGENTA = "\x1b[1;35m";

function shouldSkipBannerColor(): boolean {
  if (typeof process === "undefined" || !process.env) return true;
  if ("NO_COLOR" in process.env) return true;
  const fc = process.env.FORCE_COLOR;
  if (fc === "0" || fc === "false") return true;
  if (fc === "1" || fc === "true") return false;
  if (typeof process.stdout?.isTTY === "boolean" && !process.stdout.isTTY)
    return true;
  return false;
}

function colorizeDevSettingsBannerLine(line: string): string {
  if (line.length === 0) return line;
  const c0 = line.codePointAt(0);
  if (c0 === 0x256d /* ╭ */ || c0 === 0x2570 /* ╰ */)
    return `${BOLD_CYAN}${line}${RESET}`;
  if (c0 === 0x251c /* ├ */) return `${DIM_CYAN}${line}${RESET}`;
  if (c0 === 0x2502 /* │ */) return `${DIM_CYAN}${line}${RESET}`;
  return line;
}

/** Add cyan emphasis to Unicode box lines; no-op when not a TTY or when `NO_COLOR` is set. */
export function colorizeDevSettingsBanner(text: string): string {
  if (shouldSkipBannerColor()) return text;
  return text.split("\n").map(colorizeDevSettingsBannerLine).join("\n");
}

/**
 * Colorize a block that may start with a figlet heading, then a framed table (and optional
 * plain footer after the box). Figlet lines are magenta; box lines stay cyan.
 */
export function colorizeDevSettingsStartupBanner(text: string): string {
  if (shouldSkipBannerColor()) return text;
  const idx = text.indexOf("╭");
  if (idx === -1) return colorizeDevSettingsBanner(text);
  const head = text.slice(0, idx).replace(/\n+$/u, "");
  const tail = text.slice(idx);
  const coloredHead = head ? `${BOLD_MAGENTA}${head}${RESET}\n` : "";
  return coloredHead + colorizeDevSettingsBanner(tail);
}
