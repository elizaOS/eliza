import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: path.dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: path.dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      {
        // @elizaos/ui's DynamicViewLoader statically imports this plugin-health
        // subpath; the keyless lane has no built plugin-health dist, so anchor
        // the exact subpath to source. Matches plugin-contacts/hyperliquid-app/
        // phone/wallet-ui/facewear.
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: path.join(
          repoRoot,
          "plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-messages$/,
        replacement: path.join(
          repoRoot,
          "plugins/plugin-native-messages/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-system$/,
        replacement: path.join(
          repoRoot,
          "plugins/plugin-native-system/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/components\/permissions\/PermissionRecoveryCallout$/,
        replacement: path.join(
          repoRoot,
          "packages/ui/src/components/permissions/PermissionRecoveryCallout.tsx",
        ),
      },
      {
        find: /^@elizaos\/ui\/app-navigate-view$/,
        replacement: path.join(repoRoot, "packages/ui/src/app-navigate-view.ts"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.join(repoRoot, "packages/shared/src/$1"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
