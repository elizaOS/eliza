/**
 * Guards the shell bundle's `third-party` contract by scanning real shell sources.
 *
 * `electrobun.config.ts` marks the agent runtime, plugins, and ML stacks
 * `external` for the Bun shell bundle. Those packages are therefore absent from
 * the packaged `app/bun/index.js`, which has no `node_modules` on its module
 * resolution path. A *static* import of an third-partyized package consequently
 * throws `Cannot find module` while the composition root is still evaluating,
 * inside the launcher's `Worker` — where the error is swallowed. The process
 * stays alive running an empty AppKit event loop, so the app looks healthy
 * while never producing a window, tray icon, or agent.
 *
 * Static analysis is deliberate: importing the shell entrypoint here would
 * execute native/window side effects, and the invariant under test is about
 * import edges, not runtime behavior. Externalized packages must be reached
 * through `await import(...)` at call time instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nativeDir = path.dirname(fileURLToPath(import.meta.url));
const shellSrcDir = path.resolve(nativeDir, "..");
const electrobunDir = path.resolve(shellSrcDir, "..");
const configPath = path.join(electrobunDir, "electrobun.config.ts");

/** Externals that are pure type-only dependencies of the shell are exempt. */
const TYPE_ONLY_EXTERNALS = new Set([
  "@elizaos/agent",
  "@elizaos/app-core",
  "@elizaos/shared",
]);

const EXTERNAL_BLOCK_PATTERN = /external:\s*\[([\s\S]*?)\]/;
const QUOTED_STRING_PATTERN = /"([^"]+)"/g;

function readBundleExternals(): string[] {
  const source = readFileSync(configPath, "utf8");
  const block = EXTERNAL_BLOCK_PATTERN.exec(source);
  if (!block) {
    throw new Error(`No bundle 'external' array found in ${configPath}`);
  }
  const externals: string[] = [];
  for (const match of block[1].matchAll(QUOTED_STRING_PATTERN)) {
    externals.push(match[1]);
  }
  if (externals.length === 0) {
    throw new Error(`Parsed an empty 'external' array from ${configPath}`);
  }
  return externals;
}

function collectShellSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__stubs__" || entry === "__tests__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectShellSources(full, found);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    if (full.endsWith(".d.ts") || full.includes(".test.")) continue;
    found.push(full);
  }
  return found;
}

/**
 * Static `import ... from "<spec>"` / `export ... from "<spec>"` edges that are
 * emitted into the bundle. `import type` is erased at compile time and a
 * dynamic `await import(...)` is resolved at call time, so neither can break
 * startup; both are excluded.
 */
const TYPE_IMPORT_PATTERN =
  /\b(?:import|export)\s+type\s+[\s\S]*?from\s*["'][^"']+["']/g;
const VALUE_IMPORT_PATTERN =
  /(?:^|[\s;}])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g;

function findValueImportSpecifiers(source: string): string[] {
  const withoutTypeImports = source.replace(TYPE_IMPORT_PATTERN, "");
  const specifiers: string[] = [];
  for (const match of withoutTypeImports.matchAll(VALUE_IMPORT_PATTERN)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function matchesExternal(specifier: string, external: string): boolean {
  if (external.endsWith("/*")) {
    return specifier.startsWith(external.slice(0, -1));
  }
  return specifier === external || specifier.startsWith(`${external}/`);
}

describe("electrobun shell bundle externals", () => {
  const externals = readBundleExternals();
  const sources = collectShellSources(shellSrcDir);

  it("finds the shell sources and the configured externals", () => {
    expect(externals).toEqual(
      expect.arrayContaining(["@elizaos/plugin-local-inference"]),
    );
    expect(sources.length).toBeGreaterThan(20);
  });

  it("never statically imports an externalized package", () => {
    const enforced = externals.filter((e) => !TYPE_ONLY_EXTERNALS.has(e));
    const violations: string[] = [];

    for (const file of sources) {
      const specifiers = findValueImportSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        const external = enforced.find((e) => matchesExternal(specifier, e));
        if (external) {
          violations.push(
            `${path.relative(electrobunDir, file)} statically imports "${specifier}" (external: "${external}")`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("reaches the wake-word surface lazily", () => {
    const fusedWake = readFileSync(
      path.join(nativeDir, "fused-wake.ts"),
      "utf8",
    );
    expect(fusedWake).toContain(
      'await import("@elizaos/plugin-local-inference/voice-wake")',
    );
    expect(findValueImportSpecifiers(fusedWake)).not.toContain(
      "@elizaos/plugin-local-inference/voice-wake",
    );
  });
});
