import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	root: __dirname,
	test: {
		root: __dirname,
		include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
		exclude: [
			"dist/**",
			"**/node_modules/**",
			"**/*.live.test.ts",
			"**/*.e2e.test.ts",
		],
		passWithNoTests: true,
		environment: "node",
	},
});
