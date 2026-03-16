import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const milaidyRoot = path.resolve(here, "../..");
const uiDir = path.resolve(here, "../ui");
const uiSrc = path.resolve(uiDir, "src");
const ourNodeModules = path.resolve(here, "node_modules");

/**
 * Plugin to resolve bare imports from our node_modules when importing
 * files from outside our project directory (like the UI).
 */
function resolveFromProjectNodeModules(): Plugin {
  let config: ResolvedConfig;

  return {
    name: "resolve-from-project-node-modules",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async resolveId(source, importer) {
      // Only handle bare imports (not relative, absolute, or virtual paths)
      if (
        !source ||
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("\0") ||
        source.includes("?")
      ) {
        return null;
      }

      // Only apply to imports from outside our project (the UI directory)
      if (!importer || !importer.startsWith(uiDir)) {
        return null;
      }

      // Parse the import to get package name and subpath
      const parts = source.split("/");
      const packageName = source.startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0];
      const subpath = source.startsWith("@")
        ? parts.slice(2).join("/")
        : parts.slice(1).join("/");

      const packageDir = path.join(ourNodeModules, packageName);

      // Check if package exists in our node_modules
      if (!fs.existsSync(packageDir)) {
        return null;
      }

      // Read the package.json to understand exports
      const packageJsonPath = path.join(packageDir, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

      // Handle subpath exports
      if (subpath) {
        const exports = packageJson.exports;
        if (exports) {
          // Try exact match first
          const exportKey = "./" + subpath;
          let resolved = exports[exportKey];

          // Handle conditional exports
          if (resolved && typeof resolved === "object") {
            resolved = resolved.import || resolved.default || resolved.browser;
          }

          if (typeof resolved === "string") {
            return path.join(packageDir, resolved);
          }
        }

        // Fallback: direct path resolution
        const directPath = path.join(packageDir, subpath);
        if (fs.existsSync(directPath)) {
          return directPath;
        }
        // Try with .js extension
        if (fs.existsSync(directPath + ".js")) {
          return directPath + ".js";
        }
      }

      // Main entry point
      const exports = packageJson.exports;
      if (exports) {
        let mainExport = exports["."];
        if (mainExport && typeof mainExport === "object") {
          mainExport = mainExport.import || mainExport.default || mainExport.browser;
        }
        if (typeof mainExport === "string") {
          return path.join(packageDir, mainExport);
        }
      }

      // Fallback to module/main fields
      const main = packageJson.module || packageJson.main || "index.js";
      return path.join(packageDir, main);
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  publicDir: path.resolve(here, "public"),
  plugins: [resolveFromProjectNodeModules()],
  resolve: {
    // Ensure dependencies are deduplicated
    dedupe: ["lit", "marked", "dompurify", "@noble/ed25519", "@lit/reactive-element"],
    alias: [
      // Rewrite the UI's relative imports to milaidy/src/gateway
      // The UI uses paths like "../../../../src/gateway/device-auth.js"
      // from files in milaidy/apps/ui/src/ui/
      {
        find: /^\.\.\/\.\.\/\.\.\/\.\.\/src\/gateway\/(.*)/,
        replacement: path.resolve(milaidyRoot, "src/gateway/$1"),
      },
      // Also handle 3-level relative imports from milaidy/apps/ui/src/
      {
        find: /^\.\.\/\.\.\/\.\.\/src\/gateway\/(.*)/,
        replacement: path.resolve(milaidyRoot, "src/gateway/$1"),
      },
      // Allow importing from the shared UI source with @ui alias
      {
        find: "@ui",
        replacement: uiSrc,
      },
      // Allow importing from the milaidy src (but NOT @milaidy/capacitor-* plugin packages)
      {
        find: /^@milaidy(?!\/capacitor-)/,
        replacement: path.resolve(milaidyRoot, "src"),
      },
    ],
  },
  optimizeDeps: {
    include: [
      "lit",
      "lit/decorators.js",
      "lit/directives/repeat.js",
      "lit/directives/class-map.js",
      "lit/directives/style-map.js",
      "lit/directives/unsafe-html.js",
      "marked",
      "dompurify",
      "@noble/ed25519",
    ],
  },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: path.resolve(here, "index.html"),
      },
    },
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    fs: {
      // Allow serving files from the UI directory and milaidy src
      allow: [here, uiDir, milaidyRoot],
    },
  },
});
