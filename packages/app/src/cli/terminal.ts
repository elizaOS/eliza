import chalk, { Chalk } from "chalk";

const CLI_PALETTE = {
  accent: "#FF5A2D",
  accentBright: "#FF7A3D",
  accentDim: "#D14A22",
  info: "#FF8A5B",
  success: "#2FBF71",
  warn: "#FFB020",
  error: "#E23D2D",
  muted: "#8B7F77",
} as const;

const terminalEnv: NodeJS.ProcessEnv | undefined =
  typeof process === "undefined" ? undefined : process.env;

const forceColor = terminalEnv?.FORCE_COLOR;
const hasForceColor =
  typeof forceColor === "string" &&
  forceColor.trim().length > 0 &&
  forceColor.trim() !== "0";

const hasNoColor = terminalEnv?.NO_COLOR !== undefined;

const baseChalk =
  terminalEnv === undefined || (hasNoColor && !hasForceColor)
    ? new Chalk({ level: 0 })
    : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(CLI_PALETTE.accent),
  accentBright: hex(CLI_PALETTE.accentBright),
  accentDim: hex(CLI_PALETTE.accentDim),
  info: hex(CLI_PALETTE.info),
  success: hex(CLI_PALETTE.success),
  warn: hex(CLI_PALETTE.warn),
  error: hex(CLI_PALETTE.error),
  muted: hex(CLI_PALETTE.muted),
  heading: baseChalk.bold.hex(CLI_PALETTE.accent),
  command: hex(CLI_PALETTE.accentBright),
  option: hex(CLI_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

const DOCS_ROOT = "https://docs.eliza.ai";
function stripTerminalControlBytes(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("");
}

export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const safeLabel = stripTerminalControlBytes(label);
  const safeUrl = stripTerminalControlBytes(url);
  const allow = opts?.force ?? Boolean(process.stdout.isTTY);
  if (!allow) {
    return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
  }
  return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}

export function formatDocsLink(
  path: string,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const trimmed = path.trim();
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
