import * as path from "node:path";
import type { CoderConfig } from "../types";

function parseBool(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseIntMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function loadCoderConfig(): CoderConfig {
  const enabled = parseBool(process.env.CODER_ENABLED);
  const allowedDirectoryRaw = (
    process.env.CODER_ALLOWED_DIRECTORY ?? ""
  ).trim();
  const allowedDirectory = allowedDirectoryRaw
    ? path.resolve(allowedDirectoryRaw)
    : process.cwd();

  const timeoutMs = parseIntMs(process.env.CODER_TIMEOUT, 30_000);

  const forbiddenCommands = (process.env.CODER_FORBIDDEN_COMMANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { enabled, allowedDirectory, timeoutMs, forbiddenCommands };
}
