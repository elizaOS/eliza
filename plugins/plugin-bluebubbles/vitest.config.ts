/** Vitest config for the BlueBubbles plugin: Node environment, tests under `__tests__/` and colocated `src/**`. */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["dist/**", "**/node_modules/**"],
	},
});
