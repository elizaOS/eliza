// The page as the browser gets it: src/web/index.html and what it loads, `.vibe` included, in dist/web,
// which src/main.vibe serves. Storybook builds the components with the same plugins.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import vibelang from "vibelang-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [vibelang(), react(), tailwindcss()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
