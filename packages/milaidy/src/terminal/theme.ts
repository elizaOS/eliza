import chalk, { Chalk } from "chalk";
import { CLI_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

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

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
