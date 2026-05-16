import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"],
		alias: {
			"@elizaos/core": fileURLToPath(
				new URL("../../packages/core/src/index.node.ts", import.meta.url),
			),
			"@elizaos/plugin-capacitor-bridge": fileURLToPath(
				new URL("../plugin-capacitor-bridge/src/index.ts", import.meta.url),
			),
			"@elizaos/plugin-computeruse": fileURLToPath(
				new URL("../plugin-computeruse/src/index.ts", import.meta.url),
			),
			"@elizaos/shared/local-inference": fileURLToPath(
				new URL(
					"../../packages/shared/src/local-inference/index.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared/voice/voice-cancellation-token": fileURLToPath(
				new URL(
					"../../packages/shared/src/voice/voice-cancellation-token.ts",
					import.meta.url,
				),
			),
			"@elizaos/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: "node",
		// I7/I8/I9 tests live next to their sources under `src/` (voice-budget,
		// device-tier, active-model co-locate `.test.ts` siblings). Keep the
		// `__tests__/**` glob for legacy suites and ALSO pick up co-located
		// `.test.ts` files under `src/` so they actually run via
		// `bun --filter @elizaos/plugin-local-inference verify`.
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		exclude: [
			"dist/**",
			"node_modules/**",
			"**/*.e2e.test.ts",
			"**/*.live.test.ts",
			"**/*.real.test.ts",
		],
	},
});
