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
		baseURL: "http://localhost:13789",
	},
	projects: [
		{
			name: "e2e",
			use: {},
		},
	],
	reporter: [["list"]],
});
