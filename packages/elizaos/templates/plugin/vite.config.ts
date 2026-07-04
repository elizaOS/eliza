/**
 * Vite build configuration for scaffolded plugin runtime and frontend assets.
 */

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), react()],
	base: "./",
	build: {
		emptyOutDir: false, // Preserve plugin runtime outputs emitted before Vite runs.
		outDir: "dist",
		manifest: true,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
});
