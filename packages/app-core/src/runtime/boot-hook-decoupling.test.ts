/**
<<<<<<< HEAD
 * Grep-guard for arch-audit #12089 item 18: the boot tail no longer hard-wires
 * plugin-local-inference internals at fixed init points. The pre-ready
 * local-inference boot (mobile-gate warning + platform-appropriate model-handler
 * registration) moved into the plugin's `registerLocalInferenceBoot` hook,
 * declared in its `registry-entry.json` and drained by the generic boot-hook
 * channel (`runBootHooks` / `drainBootHookContributors`). This statically scans
 * the runtime host and contributor module to prove the old fixed-point coupling
 * is gone from the executable path. Runs against the real source tree, no mocks.
=======
 * Static integration guard for the registry-driven pre-ready hook channel. It
 * proves the shared agent host owns the single drain point and app-core does
 * not hardcode a feature plugin into executable startup code. The shared host
 * retains one explicit fallback for packaged builds with no staged registry.
>>>>>>> 6f9fa8ef572 (fix(ci): repair post-merge workflow regressions)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CONTRIBUTORS_TS = join(HERE, "startup", "app-contributors.ts");
const APP_RUNTIME_HOST_TS = join(HERE, "startup", "app-runtime-host.ts");

/**
 * The body of `repairRuntimeAfterBoot`, where the local-inference boot handler
 * was hard-wired at fixed init points. We scope the grep to this function so a
 * legitimate reference elsewhere (e.g. the still-lazy embedding-warmup accessor,
 * which is a separate subsystem, or a doc comment) does not defeat the guard.
 */
function repairRuntimeAfterBootBody(source: string): string {
  const start = source.indexOf("async function repairRuntimeAfterBoot(");
  expect(start).toBeGreaterThan(-1);
  // The next top-level `async function` / `function` declaration ends the body.
  const rest = source.slice(start + 1);
  const nextDecl = rest.search(/\n(?:async function|function) /);
  expect(nextDecl).toBeGreaterThan(-1);
  return rest.slice(0, nextDecl);
}

describe("boot-tail local-inference decoupling (arch-audit #12089 item 18)", () => {
  it("repairRuntimeAfterBoot drains the generic boot-hook channel instead of naming local-inference internals", () => {
    const body = repairRuntimeAfterBootBody(
      readFileSync(APP_RUNTIME_HOST_TS, "utf8"),
    );

    // The migration: the boot tail now drains registry-declared boot hooks.
    expect(body).toContain("runBootHooks(runtime)");

    // The old fixed-point coupling must be gone from the executable boot path:
    // no direct calls to the local-inference boot internals the audit flagged.
    expect(body).not.toContain("ensureLocalInferenceHandler(runtime)");
    expect(body).not.toContain("shouldEnableMobileLocalInference()");
    expect(body).not.toContain("warnIfMobileGateActiveWithoutPlatform(");
  });

<<<<<<< HEAD
  it("resolves boot-hook contributors from the registry by data, naming no plugin", () => {
    const source = readFileSync(APP_CONTRIBUTORS_TS, "utf8");
    // The contributor resolver scans the registry (apps + plugins) for a
    // declared `bootHook` — data-driven, no hard-wired specifier.
    expect(source).toContain("entry.launch?.bootHook");
    expect(source).toContain("getBootHookContributors");
=======
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
>>>>>>> 6f9fa8ef572 (fix(ci): repair post-merge workflow regressions)
  });
});
