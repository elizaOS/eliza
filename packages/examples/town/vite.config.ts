import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
const workspaceRoot = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);

export default defineConfig({
  define: {
    __HMR_CONFIG_NAME__: JSON.stringify("client"),
  },
  plugins: [react()],
  resolve: {
    alias: {
      react: resolve(workspaceRoot, "node_modules/react"),
      "react-dom": resolve(workspaceRoot, "node_modules/react-dom"),
      "react/jsx-runtime": resolve(
        workspaceRoot,
        "node_modules/react/jsx-runtime.js",
      ),
      "react/jsx-dev-runtime": resolve(
        workspaceRoot,
        "node_modules/react/jsx-dev-runtime.js",
      ),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
