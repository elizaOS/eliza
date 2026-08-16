/** Configures Playwright e2e execution for @elizaos/core runtime smoke tests. */
import { defineConfig } from "@playwright/test";

process.env.ELIZA_PLAYWRIGHT_E2E = "1";

export default defineConfig({
	testDir: "./e2e",
	globalSetup: "./e2e/setup/global-setup.ts",
	globalTeardown: "./e2e/setup/global-teardown.ts",
	timeout: 120_000,
	expect: {
		timeout: 30_000,
	},
	use: {
		// Kernel-assigned per run: global-setup binds port 0 and advertises the
		// bound origin here. Workers re-evaluate this config after inheriting the
		// runner's env (the same channel that carries __E2E_SKIP__), so the value
		// is always set by the time a worker resolves it (#18359).
		baseURL: process.env.CORE_E2E_BASE_URL,
	},
	projects: [
		{
			name: "e2e",
			use: {},
		},
	],
	reporter: [["list"]],
});
