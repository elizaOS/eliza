/** Local visual QA harness for the production Notes presentation component. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "../../packages/app/node_modules/@tailwindcss/vite/dist/index.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(packageRoot, "src/views/__e2e__"),
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(packageRoot, "src/views/__e2e__/ui-shim.ts"),
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: path.join(
          packageRoot,
          "src/views/__e2e__/agent-surface-shim.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/api(?:\/client-types-core)?$/,
        replacement: path.join(packageRoot, "src/views/__e2e__/api-shim.ts"),
      },
      {
        find: /^@elizaos\/ui\/components\/shared\/ViewHeader$/,
        replacement: path.join(
          packageRoot,
          "src/views/__e2e__/view-header-shim.tsx",
        ),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 2196,
    strictPort: true,
  },
});
