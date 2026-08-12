/**
 * Parity: shared formatError / resolveAliasedEnvValue copies must keep the
 * repository-required // error-policy:J<N> annotations from core (#18056 review).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatError } from "./format-error.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts: string[]): string {
  return readFileSync(path.join(here, ...parts), "utf8");
}

describe("shared error-policy parity with core copies", () => {
  it("formatError retains J7 on both catch handlers", () => {
    const src = readSrc("format-error.ts");
    const j7 = [...src.matchAll(/\/\/ error-policy:J7\b/g)];
    expect(j7.length).toBeGreaterThanOrEqual(2);
    // Behavioral parity with core: hostile String() still yields a printable tag.
    const hostile = Object.create(null);
    Object.defineProperty(hostile, Symbol.toPrimitive, {
      get() {
        throw new Error("poisoned");
      },
    });
    expect(formatError(hostile)).toMatch(/^\[object /);
  });

  it("boot-config-store getProcessEnv retains J4", () => {
    const src = readSrc("config", "boot-config-store.ts");
    expect(src).toMatch(
      /catch\s*\{[\s\S]*?\/\/ error-policy:J4 browser and edge runtimes/,
    );
  });
});
