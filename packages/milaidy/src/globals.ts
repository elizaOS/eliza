import { logger } from "@elizaos/core";
import { theme } from "./terminal/theme.js";

const TRUTHY_VALUES = new Set(["true", "1", "yes", "on"]);

export function isTruthyEnvValue(value: string | undefined): boolean {
  return TRUTHY_VALUES.has((value ?? "").trim().toLowerCase());
}

const LOG_LEVEL_PRIORITY: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

function isLogLevelEnabled(level: string): boolean {
  const current = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (LOG_LEVEL_PRIORITY[level] ?? 30) >= (LOG_LEVEL_PRIORITY[current] ?? 30);
}

let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function shouldLogVerbose() {
  return globalVerbose || isLogLevelEnabled("debug");
}

export function logVerbose(message: string) {
  if (!shouldLogVerbose()) {
    return;
  }
  try {
    logger.debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}
