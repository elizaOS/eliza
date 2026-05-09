/**
 * Hook eligibility: checks OS, binary, env, and config requirements.
 */

import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import type { HookConfig, InternalHooksConfig } from "../config/types.hooks.ts";
import type { ElizaHookMetadata } from "./types.ts";

function binaryExists(name: string): boolean {
  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => ext.trim().toLowerCase())
          .filter(Boolean)
      : [];
  const baseCandidates =
    process.platform === "win32" && extname(name) === ""
      ? [name, ...pathExts.map((ext) => `${name}${ext}`)]
      : [name];

  if (
    isAbsolute(name) &&
    baseCandidates.some((candidate) => existsSync(candidate))
  ) {
    return true;
  }

  const pathDirs = [
    ...new Set(
      [
        (process.env.PATH ?? "").split(delimiter),
        dirname(process.execPath),
      ].flat(),
    ),
  ].filter(Boolean);
  for (const dir of pathDirs) {
    for (const candidate of baseCandidates) {
      if (existsSync(join(dir, candidate))) return true;
    }
  }
  return false;
}

function resolveConfigPath(
  config: Record<string, unknown>,
  pathStr: string,
): unknown {
  const parts = pathStr.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isConfigPathTruthy(
  config: Record<string, unknown>,
  pathStr: string,
): boolean {
  const value = resolveConfigPath(config, pathStr);
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== "" &&
    value !== 0
  );
}

export interface EligibilityResult {
  eligible: boolean;
  missing: string[];
}

export function checkEligibility(
  metadata: ElizaHookMetadata | undefined,
  hookConfig: HookConfig | undefined,
  elizaConfig: Record<string, unknown> = {},
): EligibilityResult {
  const missing: string[] = [];

  if (!metadata) {
    return { eligible: true, missing: [] };
  }

  // Note: hookConfig.enabled is intentionally NOT checked here.
  // "Disabled" (user choice) vs "ineligible" (missing requirements) are
  // separate concerns — the loader handles the enabled flag.

  if (metadata.os && metadata.os.length > 0) {
    if (!metadata.os.includes(platform())) {
      missing.push(
        `OS: requires ${metadata.os.join("|")}, current: ${platform()}`,
      );
    }
  }

  if (metadata.always) {
    return { eligible: missing.length === 0, missing };
  }

  if (metadata.requires?.bins) {
    for (const bin of metadata.requires.bins) {
      if (!binaryExists(bin)) {
        missing.push(`Binary missing: ${bin}`);
      }
    }
  }

  if (metadata.requires?.anyBins && metadata.requires.anyBins.length > 0) {
    const hasAny = metadata.requires.anyBins.some(binaryExists);
    if (!hasAny) {
      missing.push(`None of: ${metadata.requires.anyBins.join(", ")}`);
    }
  }

  if (metadata.requires?.env) {
    for (const envVar of metadata.requires.env) {
      const hasInProcess = Boolean(process.env[envVar]);
      const hasInHookConfig = Boolean(hookConfig?.env?.[envVar]);
      if (!hasInProcess && !hasInHookConfig) {
        missing.push(`Env missing: ${envVar}`);
      }
    }
  }

  if (metadata.requires?.config) {
    for (const configPath of metadata.requires.config) {
      if (!isConfigPathTruthy(elizaConfig, configPath)) {
        missing.push(`Config missing: ${configPath}`);
      }
    }
  }

  return { eligible: missing.length === 0, missing };
}

export function resolveHookConfig(
  internalConfig: InternalHooksConfig | undefined,
  hookKey: string,
): HookConfig | undefined {
  return internalConfig?.entries?.[hookKey];
}
