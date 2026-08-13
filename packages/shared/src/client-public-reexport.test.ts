/**
 * Shared imports the published `@elizaos/core/client-public` subpath rather
 * than a sibling source tree, and preserves the exact helper implementations.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatError as publicFormatError,
  isTruthyEnvValue as publicIsTruthy,
  resolveAliasedEnvValue as publicResolveAlias,
  sanitizeForSettingsDebug as publicSanitize,
  isElizaSettingsDebugEnabled as publicSettingsDebugEnabled,
} from "@elizaos/core/client-public";
import { describe, expect, it } from "vitest";
import { resolveAliasedEnvValue } from "./config/boot-config-store.ts";
import { isTruthyEnvValue } from "./env-utils.ts";
import { formatError } from "./format-error.ts";
import {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
} from "./settings-debug.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts: string[]): string {
  return readFileSync(path.join(here, ...parts), "utf8");
}

describe("shared re-exports @elizaos/core/client-public, not core source files", () => {
  it("source files import the package subpath only", () => {
    const files = [
      readSrc("format-error.ts"),
      readSrc("env-utils.ts"),
      readSrc("config", "boot-config-store.ts"),
      readSrc("settings-debug.ts"),
    ];
    for (const src of files) {
      expect(src).toMatch(/from ["']@elizaos\/core\/client-public["']/);
      expect(src).not.toMatch(/\.\.\/.*core\/src\//);
      expect(src).not.toMatch(/export function formatError\(/);
      expect(src).not.toMatch(/export function isTruthyEnvValue/);
      expect(src).not.toMatch(/export function resolveAliasedEnvValue/);
      expect(src).not.toMatch(/export function sanitizeForSettingsDebug/);
    }
  });

  it("shared symbols are the client-public implementations", () => {
    expect(formatError).toBe(publicFormatError);
    expect(isTruthyEnvValue).toBe(publicIsTruthy);
    expect(resolveAliasedEnvValue).toBe(publicResolveAlias);
    expect(sanitizeForSettingsDebug).toBe(publicSanitize);
    expect(isElizaSettingsDebugEnabled).toBe(publicSettingsDebugEnabled);
  });
});
