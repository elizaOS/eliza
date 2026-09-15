/**
 * Chalk-based color theme for CLI output, built from the shared `CLI_PALETTE`.
 * Honors `NO_COLOR` and `FORCE_COLOR` when deciding whether to emit ANSI colors.
 */
import chalk, { Chalk } from "chalk";
import { CLI_PALETTE } from "./palette.js";

// The shared barrel is imported by browser bundles; a bare `process`
// identifier at module scope throws ReferenceError there and kills the whole
// graph before any consumer mounts.
// Without a process, take the same no-color path as dev-settings-banner-style
// and self-edit: a browser context cannot honor CLI color env vars.
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

export const cyberGreen = hex("#00FF41");

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (
  rich: boolean,
  color: (value: string) => string,
  value: string,
) => (rich ? color(value) : value);
