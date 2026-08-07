/**
 * Static integration guard for the registry-driven pre-ready hook channel. It
 * proves the shared agent host owns the single drain point and app-core does
 * not hardcode a feature plugin into executable startup code. The shared host
 * retains one explicit fallback for packaged builds with no staged registry.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_RUNTIME_TS = join(HERE, "../../../agent/src/runtime/eliza.ts");
const AGENT_BOOT_HOOKS_TS = join(
  HERE,
  "../../../agent/src/runtime/boot-hooks.ts",
);
const APP_RUNTIME_HOST_TS = join(HERE, "startup", "app-runtime-host.ts");

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextDeclaration = rest.search(/\n(?:async function|function|export ) /);
  return nextDeclaration > -1 ? rest.slice(0, nextDeclaration) : rest;
}

describe("pre-ready boot-hook ownership", () => {
  it("drains registry-declared hooks from the shared agent initialization path", () => {
    const source = readFileSync(AGENT_RUNTIME_TS, "utf8");
    const initializeBody = functionBody(
      source,
      "const initializeCoreRuntime = async (): Promise<void> => {",
    );

    expect(initializeBody).toContain("await runBootHooks(runtime)");
    expect(initializeBody).not.toContain("registerLocalInferenceBoot");
  });

  it("does not drain the same hook again during app-core repair", () => {
    const source = readFileSync(APP_RUNTIME_HOST_TS, "utf8");
    const repairBody = functionBody(
      source,
      "export async function repairRuntimeAfterBoot(",
    );

    expect(repairBody).not.toContain("runBootHooks(runtime)");
    expect(repairBody).not.toContain("registerLocalInferenceBoot");
  });

  it("resolves registry hooks and retains the packaged local-inference fallback", () => {
    const source = readFileSync(AGENT_BOOT_HOOKS_TS, "utf8");

    expect(source).toContain("entry.launch?.bootHook");
    expect(source).toContain("getBootHookContributors");
    expect(source).toContain("FALLBACK_BOOT_HOOK_DECLARATIONS");
    expect(source).toContain("@elizaos/plugin-local-inference/runtime");
    expect(source).toContain("registerLocalInferenceBoot");
  });
});
