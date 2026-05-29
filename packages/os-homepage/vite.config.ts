import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
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

function pruneStaticAssets(): Plugin {
  return {
    name: "prune-os-homepage-static-assets",
    apply: "build",
    closeBundle() {
      const outDir = path.resolve(packageDir, "dist");
      const removePatterns = [
        /^clouds\/clouds_(?:1x|8x)_/,
        /^clouds\/poster(?:-480p|-720p)?\.(?:jpg|webp)$/,
        /^brand\/background\/Clouds_Loop_/,
        /^brand\/concepts\/(?:billboard_concept|chibi_usb_concept|concept_minipc|concept_phone|concept_usbdrive)\.jpg$/,
      ];

      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          const relativePath = path
            .relative(outDir, fullPath)
            .replace(/\\/g, "/");
          if (removePatterns.some((pattern) => pattern.test(relativePath))) {
            fs.rmSync(fullPath, { force: true });
          }
        }
      };

      walk(outDir);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    spa404Fallback(),
    pruneStaticAssets(),
    visualizer({
      filename: "dist/stats.html",
      gzipSize: true,
      brotliSize: true,
    }) as Plugin,
  ],
  resolve: {
    dedupe: ["react", "react-dom", "react-router", "react-router-dom", "zod"],
    alias: [
      { find: /^@\//, replacement: `${path.resolve(packageDir, "./src")}/` },
      {
        find: /^@elizaos\/shared\/brand$/,
        replacement: path.resolve(packageDir, "../shared/src/brand/index.ts"),
      },
      {
        find: /^@elizaos\/shared\/checkout$/,
        replacement: path.resolve(
          packageDir,
          "../shared/src/checkout/index.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/hardware-catalog$/,
        replacement: path.resolve(
          packageDir,
          "../shared/src/hardware-catalog/index.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/steward-session-client$/,
        replacement: path.resolve(
          packageDir,
          "../shared/src/steward-session-client/index.ts",
        ),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.resolve(
          packageDir,
          "../ui/src/backgrounds/CloudVideoBackground.tsx",
        ),
      },
      {
        find: /^@elizaos\/ui\/button$/,
        replacement: path.resolve(
          packageDir,
          "../ui/src/cloud-ui/components/button.tsx",
        ),
      },
      {
        find: /^@elizaos\/ui\/card$/,
        replacement: path.resolve(
          packageDir,
          "../ui/src/components/ui/card.tsx",
        ),
      },
      {
        find: /^@elizaos\/ui\/product-switcher$/,
        replacement: path.resolve(
          packageDir,
          "../ui/src/cloud-ui/components/product-switcher.tsx",
        ),
      },
      {
        find: /^@elizaos\/ui\/i18n\/region$/,
        replacement: path.resolve(packageDir, "../ui/src/i18n/region.ts"),
      },
    ],
  },
  server: {
    port: 4455,
  },
  preview: {
    port: 4455,
  },
  build: {
    rolldownOptions: {
      checks: {
        pluginTimings: false,
      },
    },
  },
});
