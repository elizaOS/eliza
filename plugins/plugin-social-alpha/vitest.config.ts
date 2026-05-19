import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.{test,spec}.ts", "**/*.{test,spec}.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "src/tests/**/*"],
	},
});
