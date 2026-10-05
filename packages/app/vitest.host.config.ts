/** Defines app vitest behavior for dashboard host and runtime integration. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { compoundVitestEvidence } from "../scripts/lib/compound-test-evidence.ts";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases.ts";
import { discoverScriptTestLanes } from "./scripts/lib/script-test-lanes.ts";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const scriptTestLanes = discoverScriptTestLanes(fileDir);
const monorepoRoot = path.resolve(fileDir, "../..");
// Resolve react/react-dom from the location of this config file so the alias
// works whether react is hoisted to the monorepo root or installed locally.
// createRequire resolves through the normal Node resolution algorithm (walks up
// node_modules directories), so it finds the correct copy regardless of where
// the package manager decided to hoist it.
const _require = createRequire(import.meta.url);
const reactPkg = path.dirname(_require.resolve("react/package.json"));
const reactDomPkg = path.dirname(_require.resolve("react-dom/package.json"));

/**
 * Real `react` / `react-dom` packages (not .d.ts stubs from tsconfig paths)
 * so Vite can execute files that import from workspace apps under tests.
 * Workspace `exports` and deep imports are mirrored here for Vitest’s resolver.
 */
export default defineConfig({
  test: {
    ...compoundVitestEvidence(),
    include: [
      "src/connectors/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/config/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/security/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/platform/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/runtime/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/utils/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/cli/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/permissions/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/styles/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/diagnostics/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/registry/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/first-run/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/api/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/services/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/stubs/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/dev-stack/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/electrobun/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/app/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/browser-extension/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/live-agent/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/benchmarks/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/fixtures/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/automations/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/helpers/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/services/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Keep the PGlite and RS256-heavy suites serial to cap resource pressure.
    // File isolation prevents mock state from leaking across the package and
    // avoids shared-module-registry deadlocks under concurrent repository runs.
    maxWorkers: 1,
    isolate: true,
    server: { deps: { inline: [/@elizaos\//] } },
    // Heavy browser e2e — install `puppeteer-core` / `playwright-core` in this package to run
    exclude: [
      ...scriptTestLanes["node:test"],
      ...scriptTestLanes["bun:test"],
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      // #9310 §E: the guarded *.live.test.ts suite (opt-in gated, self-skips)
      // is invocable only in the post-merge lane, where run-all-tests.ts
      // prints a named skip accounting.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["**/*.live.test.{ts,tsx}"]),
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
      "{src,test,__tests__}/**/*.spec.{ts,tsx}",
      "platforms/electrobun/**",
      ...(process.platform === "win32"
        ? [
            // These suites fail ONLY on the GitHub-hosted windows-ci runner with
            // a bare "SyntaxError: Invalid or unexpected token" at transform /
            // collection time (each reports as a "0 test" failed suite). Every
            // file is valid (`node --check` passes), byte-identical to develop
            // (no BOM, no CRLF; content is not the trigger — the ones with zero
            // non-ASCII bytes fail identically, and the two with a byte only
            // carry an em-dash in a prose comment). Each passes on every Linux
            // lane and locally on Windows under bun stable AND canary, both
            // single-file and full-suite. Not reproducible off the CI runner →
            // a windows-ci transform/environment anomaly, not a logic failure.
            // Gated on Windows CI pending a root-cause that needs the runner
            // itself; every one of these still runs on Linux.
            "scripts/lib/apple-entitlement-audit.test.ts",
            "scripts/run-mobile-build-ios-engine-gate.test.ts",
            "scripts/run-mobile-build-android-cloud-strip.test.ts",
            "scripts/run-mobile-build-android-targets.test.ts",
            "scripts/run-mobile-build-ios-identity.test.ts",
            "scripts/run-mobile-build-plugin-manifest.test.ts",
            "scripts/voice-interactive.test.ts",
            "scripts/aosp/compile-libllama.test.ts",
          ]
        : []),
      ".claude/**",
      "test/app/memory-relationships.real.e2e.test.ts",
      "test/app/qa-checklist.real.e2e.test.ts",
    ],
  },
  resolve: {
    alias: [
      { find: "react", replacement: reactPkg },
      {
        find: "react/jsx-runtime",
        replacement: path.join(reactPkg, "jsx-runtime.js"),
      },
      {
        find: "react/jsx-dev-runtime",
        replacement: path.join(reactPkg, "jsx-dev-runtime.js"),
      },
      { find: "react-dom", replacement: reactDomPkg },
      {
        find: "react-dom/client",
        replacement: path.join(reactDomPkg, "client.js"),
      },
      {
        find: "node-llama-cpp",
        replacement: path.join(fileDir, "test-stubs/node-llama-cpp.ts"),
      },
      // Resolve remaining workspace plugins from source in a clean checkout.
      // Keep explicit host aliases and test doubles above these fallbacks.
      ...buildWorkspaceSourceAliases(monorepoRoot),
    ],
  },
});
