/**
 * Shared `__e2e__` fixture-runner toolkit: esbuild stubs, fixture bundling + HTML
 * assembly, and the Chromium harness (assert gate, snapper, video rename, exit,
 * and the `runBrowserFixtureE2E` orchestrator). The `run-*.mjs` runners compose
 * these instead of copy-pasting the mechanics; contract + usage live in
 * `packages/ui/src/components/shell/__e2e__/` and `packages/ui/AGENTS.md`.
 */

export {
  type AssertGate,
  type BrowserFixtureConfig,
  type BrowserFixtureScenarioContext,
  createAssertGate,
  createSnapper,
  finishRun,
  renameRecordedVideo,
  runBrowserFixtureE2E,
  type Snapper,
  withChromium,
} from "./browser-harness.ts";
export { stubElizaCore, stubNodeBuiltins } from "./esbuild-stubs.ts";
export {
  type BundleFixtureOptions,
  buildFixtureHtml,
  bundleFixture,
  type CompileTailwindThemeOptions,
  compileTailwindTheme,
  type FixtureHtmlOptions,
  type WriteFixturePageOptions,
  writeFixturePage,
} from "./fixture-bundle.ts";
