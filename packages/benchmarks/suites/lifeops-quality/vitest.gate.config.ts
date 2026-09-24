// Gate lane: drives the REAL LifeOps code — the plugin-inbox triage classifier
// and the plugin-personal-assistant scheduled-task tick over a real
// PGlite-backed runtime with an injected clock.
//
// The code under test lives in the elizaOS monorepo, not this repo. Point
// ELIZA_REPO_DIR at an elizaOS checkout (with dependencies installed and the
// plugin-personal-assistant dependency graph built); this config reuses that
// checkout's plugin-personal-assistant src-integration vitest config (the
// proven resolve/alias/stub wiring for booting the PA plugin barrel +
// scheduling spine under vitest) and swaps the include to this package's
// `*.gate.test.ts` files. The `@eliza-repo` alias maps the gate tests'
// plugin imports into the checkout.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bundleRequire } from "bundle-require";
import { defineConfig, type ViteUserConfig } from "vitest/config";

function elizaRepoDir(): string {
  const raw = process.env.ELIZA_REPO_DIR?.trim();
  if (!raw) {
    throw new Error(
      "ELIZA_REPO_DIR is not set. The lifeops-quality gate lanes drive real " +
        "elizaOS plugin code — point ELIZA_REPO_DIR at an elizaOS monorepo " +
        "checkout with dependencies installed.",
    );
  }
  const repo = resolve(raw);
  const probe = resolve(
    repo,
    "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
  );
  if (!existsSync(probe)) {
    throw new Error(
      `ELIZA_REPO_DIR=${repo} does not look like an elizaOS checkout (missing ${probe}).`,
    );
  }
  return repo;
}

export default defineConfig(async () => {
  const repo = elizaRepoDir();
  // bundle-require (esbuild) rather than a bare dynamic import: the PA config
  // uses extensionless TS-path imports that plain node ESM cannot resolve.
  const { mod } = await bundleRequire({
    filepath: resolve(
      repo,
      "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
    ),
  });
  const paIntegrationConfig = mod.default as ViteUserConfig;

  const suiteDir = import.meta.dirname;
  const baseResolve = paIntegrationConfig.resolve ?? {};
  // The PA config's alias is an ORDERED ARRAY of regex aliases — preserve its
  // form (an object spread would destroy the regex entries) and append the
  // `@eliza-repo` mapping used by this suite's gate tests.
  const baseAlias = baseResolve.alias ?? [];
  const elizaRepoAlias = { find: /^@eliza-repo\/(.+)$/, replacement: `${repo}/$1` };
  const alias = Array.isArray(baseAlias)
    ? [...baseAlias, elizaRepoAlias]
    : [
        ...Object.entries(baseAlias).map(([find, replacement]) => ({
          find,
          replacement: replacement as string,
        })),
        elizaRepoAlias,
      ];
  return {
    ...paIntegrationConfig,
    resolve: {
      ...baseResolve,
      alias,
    },
    test: {
      ...paIntegrationConfig.test,
      include: [`${suiteDir}/**/*.gate.test.ts`],
      // The timeliness gate replays ~2,300 scheduler ticks against PGlite.
      testTimeout: 900_000,
      hookTimeout: 180_000,
    },
  };
});
