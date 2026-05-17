import { defineConfig } from "@playwright/test";

// NOTE: this config intentionally has no `webServer`. The packaged Electrobun
// e2e suite expects the app binary to be built out-of-band before invocation
// (via `bun run build` at the workspace root, which transitively builds
// `@elizaos/shared`'s dist). Driving a clean prod build from `webServer.command`
// has historically failed when `@elizaos/shared`'s `dist/` is missing because
// the package's `main`/`exports` only resolve once `bun run build` has produced
// `packages/shared/dist/index.js`. If you need a green run without an existing
// build, run `bun run --cwd packages/shared build` first, or skip this suite
// (`PLAYWRIGHT_SKIP_PACKAGED=1`) and rely on `playwright.ui-smoke.config.ts`
// which points at the dev stack (`packages/app-core/scripts/playwright-ui-live-stack.ts`).
export default defineConfig({
  testDir: "./test/electrobun-packaged",
  testMatch: ["**/*.e2e.spec.ts"],
  testIgnore:
    process.platform === "win32"
      ? []
      : ["**/electrobun-windows-startup.e2e.spec.ts"],
  timeout: 600_000,
  expect: {
    timeout: 30_000,
  },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
