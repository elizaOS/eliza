import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@elizaos/cloud-sdk": fileURLToPath(
				new URL("../../cloud/packages/sdk/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		include: ["__tests__/**/*.test.ts"],
		environment: "node",
	},
});
