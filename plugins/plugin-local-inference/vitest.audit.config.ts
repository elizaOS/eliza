/**
 * Vitest config for the audit lane: a trimmed `@elizaos/*` alias set that runs
 * only the co-located `src/**` `.test.ts` suites, skipping the `__tests__/**`
 * legacy glob and the post-merge real-model lane.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@elizaos/core": fileURLToPath(
				new URL("../../packages/core/src/index.node.ts", import.meta.url),
			),
			"@elizaos/logger": fileURLToPath(
				new URL("../../packages/logger/src/index.ts", import.meta.url),
			),
			"@elizaos/plugin-capacitor-bridge": fileURLToPath(
				new URL("../plugin-capacitor-bridge/src/index.ts", import.meta.url),
			),
			"@elizaos/plugin-computeruse": fileURLToPath(
				new URL("../plugin-computeruse/src/index.ts", import.meta.url),
			),
			"@elizaos/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
