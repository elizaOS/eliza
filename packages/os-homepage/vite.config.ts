import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

function spa404Fallback(): Plugin {
  return {
    name: "spa-404-fallback",
    apply: "build",
    closeBundle() {
      const outDir = path.resolve(packageDir, "dist");
      const indexHtml = path.join(outDir, "index.html");
      const notFoundHtml = path.join(outDir, "404.html");
      if (fs.existsSync(indexHtml)) {
        fs.copyFileSync(indexHtml, notFoundHtml);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), spa404Fallback()],
  resolve: {
    alias: {
      "@": path.resolve(packageDir, "./src"),
      "@elizaos/ui/button": path.resolve(
        packageDir,
        "../ui/src/cloud-ui/components/button.tsx",
      ),
      "@elizaos/ui/product-switcher": path.resolve(
        packageDir,
        "../ui/src/cloud-ui/components/product-switcher.tsx",
      ),
    },
  },
  server: {
    port: 4455,
  },
  preview: {
    port: 4455,
  },
});
