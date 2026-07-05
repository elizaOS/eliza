// Guards against the ELIZA_BUILD_STAMP passthrough regression: the tester
// BuildBadge stamp (`packages/app/dist/build-info.json`) is written by
// `packages/app/scripts/build.mjs` via `shouldSkipBuildStamp()`, which reads
// ELIZA_BUILD_STAMP / ELIZA_BUILD_VARIANT / VITE_ENVIRONMENT /
// ELIZA_RELEASE_AUTHORITY. The app is built through turbo (`build:client` ->
// `run-turbo run build --filter=@elizaos/app`), and turbo STRIPS any env var
// that is not in the task's env allowlist (or globalEnv) before the task runs.
// If those policy vars are not allowlisted for the app build task, setting the
// flag has no effect and the stamp policy is undefined under turbo. This
// contract asserts the resolved env allowlist for `@elizaos/app#build` covers
// every var the stamp policy actually reads. Deterministic — parses turbo.json
// and build-stamp.mjs source, runs nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TURBO_JSON = fileURLToPath(new URL("../../../turbo.json", import.meta.url));
const BUILD_STAMP_MJS = fileURLToPath(
  new URL("../../app/scripts/build-stamp.mjs", import.meta.url),
);

// The exact vars `shouldSkipBuildStamp()` reads from `env`. If the stamp policy
// grows a new env input, add it here AND to the app build task's env allowlist
// in turbo.json — otherwise the new input is silently stripped by turbo and the
// policy becomes undefined on the normal `build:client` path.
const STAMP_POLICY_ENV = [
  "ELIZA_BUILD_STAMP",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_RELEASE_AUTHORITY",
  "VITE_ENVIRONMENT",
];

function readTurbo(): {
  globalEnv?: string[];
  tasks: Record<string, { env?: string[] }>;
} {
  return JSON.parse(readFileSync(TURBO_JSON, "utf8"));
}

/**
 * The env allowlist turbo applies to a package's `build` task: the
 * package-specific `pkg#build` entry (which fully replaces the base `build`
 * task when present) if it exists, otherwise the generic `build` task.
 */
function resolvedBuildEnv(
  turbo: ReturnType<typeof readTurbo>,
  pkg: string,
): string[] {
  const specific = turbo.tasks[`${pkg}#build`];
  const generic = turbo.tasks.build;
  const taskEnv = (specific ?? generic)?.env ?? [];
  return [...(turbo.globalEnv ?? []), ...taskEnv];
}

describe("turbo build-stamp env passthrough contract", () => {
  test("build-stamp policy reads exactly the declared STAMP_POLICY_ENV vars", () => {
    // Keep STAMP_POLICY_ENV honest against the real source: every var the
    // policy references via `env.<VAR>` must be in the list, so the allowlist
    // assertion below can never go stale silently.
    const source = readFileSync(BUILD_STAMP_MJS, "utf8");
    const referenced = new Set(
      [...source.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    );
    for (const varName of referenced) {
      expect(STAMP_POLICY_ENV).toContain(varName);
    }
    // And every declared policy var is actually read by the policy (no dead
    // entries that would give false confidence).
    for (const varName of STAMP_POLICY_ENV) {
      expect(referenced.has(varName)).toBe(true);
    }
  });

  test("@elizaos/app#build allowlists every stamp-policy env var", () => {
    const turbo = readTurbo();
    const env = resolvedBuildEnv(turbo, "@elizaos/app");
    for (const varName of STAMP_POLICY_ENV) {
      expect(env).toContain(varName);
    }
  });

  test("@elizaos/app#build preserves the generic build inputs and outputs", () => {
    // The pkg#build entry fully replaces the base `build` task, so dropping its
    // inputs/outputs would break cache invalidation. Guard that the override
    // still carries them (source changes must bust the cache; dist is emitted).
    const turbo = readTurbo();
    const appBuild = turbo.tasks["@elizaos/app#build"] as
      | { inputs?: string[]; outputs?: string[] }
      | undefined;
    expect(appBuild).toBeDefined();
    expect(appBuild?.inputs).toContain("src/**");
    expect(appBuild?.inputs).toContain("scripts/**");
    expect(appBuild?.inputs).toContain("build.mjs");
    expect(appBuild?.outputs).toContain("dist/**");
  });

  test("the app build script is wired through turbo (regression premise holds)", () => {
    // If `build:client` stops going through turbo, this contract is moot —
    // assert the premise so the guard fails loudly if the build path changes
    // out from under it.
    const rootPkg = JSON.parse(
      readFileSync(`${REPO_ROOT}/package.json`, "utf8"),
    ) as { scripts?: Record<string, string> };
    const buildClient = rootPkg.scripts?.["build:client"] ?? "";
    expect(buildClient).toContain("run-turbo.mjs");
    expect(buildClient).toContain("--filter=@elizaos/app");
  });
});
