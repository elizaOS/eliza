/**
 * Anti-drift: shared must not grow a second formatError / env-alias body.
 * Authority is `@elizaos/core` (also exported from client-public). Shared
 * re-exports the source files so vite.config can load them without dist/.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatError as coreFormatError } from "../../core/src/utils/format-error.ts";
import { resolveAliasedEnvValue as coreResolveAliasedEnvValue } from "../../core/src/boot-env.ts";
import { isTruthyEnvValue as coreIsTruthyEnvValue } from "../../core/src/env-utils.ts";
import { resolveAliasedEnvValue } from "./config/boot-config-store.ts";
import { isTruthyEnvValue } from "./env-utils.ts";
import { formatError } from "./format-error.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts: string[]): string {
  return readFileSync(path.join(here, ...parts), "utf8");
}

describe("shared helpers are core re-exports, not forks", () => {
  it("format-error.ts has no local formatError body", () => {
    const src = readSrc("format-error.ts");
    expect(src).not.toMatch(/export function formatError\(/);
    expect(src).toMatch(/from ["'].*core\/src\/utils\/format-error\.ts["']/);
    expect(formatError).toBe(coreFormatError);
  });

  it("env-utils.ts has no local isTruthyEnvValue body", () => {
    const src = readSrc("env-utils.ts");
    expect(src).not.toMatch(/export function isTruthyEnvValue/);
    expect(isTruthyEnvValue).toBe(coreIsTruthyEnvValue);
  });

  it("boot-config-store re-exports core resolveAliasedEnvValue", () => {
    const src = readSrc("config", "boot-config-store.ts");
    expect(src).not.toMatch(/export function resolveAliasedEnvValue/);
    expect(resolveAliasedEnvValue).toBe(coreResolveAliasedEnvValue);
  });

  it("core formatError retains J7 and survives hostile primitives", () => {
    const src = readFileSync(
      path.join(here, "../../core/src/utils/format-error.ts"),
      "utf8",
    );
    expect([...src.matchAll(/\/\/ error-policy:J7\b/g)].length).toBeGreaterThanOrEqual(
      2,
    );
    const hostile = Object.create(null);
    Object.defineProperty(hostile, Symbol.toPrimitive, {
      get() {
        throw new Error("poisoned");
      },
    });
    expect(formatError(hostile)).toMatch(/^\[object /);

    const throwingMessage = new Error("visible");
    Object.defineProperty(throwingMessage, "message", {
      get() {
        throw new Error("poisoned-message");
      },
    });
    expect(formatError(throwingMessage)).toMatch(/^\[object /);
  });

  it("blank ELIZA_ values do not shadow a present brand alias", () => {
    const aliases = [["MILADY_API_TOKEN", "ELIZA_API_TOKEN"]] as const;
    const env = {
      ELIZA_API_TOKEN: "   ",
      MILADY_API_TOKEN: "brand-secret",
    };
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", aliases, env)).toBe(
      "brand-secret",
    );
    expect(resolveAliasedEnvValue("UNRELATED_KEY", aliases, env)).toBeUndefined();
  });

  it("isTruthyEnvValue rejects non-strings and unknown tokens", () => {
    expect(isTruthyEnvValue("true")).toBe(true);
    expect(isTruthyEnvValue("  YES  ")).toBe(true);
    expect(isTruthyEnvValue("false")).toBe(false);
    expect(isTruthyEnvValue("maybe")).toBe(false);
    expect(isTruthyEnvValue(undefined)).toBe(false);
    expect(isTruthyEnvValue(null)).toBe(false);
  });
});
