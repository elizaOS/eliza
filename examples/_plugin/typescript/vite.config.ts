import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: "./",
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/build-order.test.ts", "**/node_modules/**"],
  },
  build: {
    emptyOutDir: false, // Preserve plugin build outputs
    outDir: "dist",
    manifest: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
