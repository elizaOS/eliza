import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(here, "../ui/src");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ui-src": uiSrc,
    },
  },
  server: {
    port: 4321,
  },
});
