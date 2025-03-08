import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	base: "/degen-intel/",
	build: {
		emptyOutDir: false,
	},
});
