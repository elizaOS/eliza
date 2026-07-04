/** Vitest config for the z.ai plugin unit suite (node environment, 60s timeouts). */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
