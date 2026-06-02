import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";

// Resolve the package + monorepo roots relative to this config file.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const monorepoRoot = resolve(packageRoot, "../..");
const uiSrc = resolve(packageRoot, "src");
const sharedSrc = resolve(monorepoRoot, "packages/shared/src");
const coreSrc = resolve(monorepoRoot, "packages/core/src");
const hostExternalStub = resolve(packageRoot, "test/stubs/host-external.ts");

// Pin react/react-dom to the single physical copy lucide-react resolves, so
// stories never hit "Invalid hook call" from a duplicate React (same strategy
// as vitest.config.ts).
const _require = createRequire(import.meta.url);
let reactPath: string;
let reactDomPath: string;
try {
  const lucidePath = _require.resolve("lucide-react");
  const lucideReq = createRequire(lucidePath);
  reactPath = dirname(lucideReq.resolve("react/package.json"));
  reactDomPath = dirname(lucideReq.resolve("react-dom/package.json"));
} catch {
  reactPath = dirname(_require.resolve("react/package.json"));
  reactDomPath = dirname(_require.resolve("react-dom/package.json"));
}

const config: StorybookConfig = {
  // Cover @elizaos/ui's own stories plus the plugin-companion CSF files, so the
  // whole component library lives in one catalog.
  stories: [
    "../src/**/*.stories.@(ts|tsx)",
    "../../../plugins/plugin-companion/src/**/*.stories.@(ts|tsx)",
  ],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  docs: { autodocs: "tag" },
  viteFinal: async (cfg) => {
    cfg.resolve ??= {};
    cfg.resolve.dedupe = [...(cfg.resolve.dedupe ?? []), "react", "react-dom"];
    cfg.resolve.alias = {
      ...(cfg.resolve.alias ?? {}),
      "@elizaos/ui": resolve(uiSrc, "index.ts"),
      "@elizaos/shared": resolve(sharedSrc, "index.ts"),
      "@elizaos/core": resolve(coreSrc, "index.node.ts"),
      // Host-only / native modules the browser catalog can't load → stubs.
      "@elizaos/app-core": hostExternalStub,
      "@elizaos/plugin-browser": hostExternalStub,
      react: resolve(reactPath, "index.js"),
      "react/jsx-runtime": resolve(reactPath, "jsx-runtime.js"),
      "react/jsx-dev-runtime": resolve(reactPath, "jsx-dev-runtime.js"),
      "react-dom": resolve(reactDomPath, "index.js"),
      "react-dom/client": resolve(reactDomPath, "client.js"),
    };
    // Shared UI source reads Node's `process.env` unguarded at module load;
    // shim it so those modules import cleanly in the browser catalog.
    cfg.define = { ...(cfg.define ?? {}), "process.env": "({})" };
    return cfg;
  },
};

export default config;
