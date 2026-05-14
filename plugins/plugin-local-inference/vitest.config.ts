import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
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
			"@elizaos/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
	},
});
