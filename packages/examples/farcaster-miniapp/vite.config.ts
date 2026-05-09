import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Prevent duplicate React copies in monorepo test/build (fixes "Invalid hook call")
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./__tests__/setup.ts"],
    globals: true,
    clearMocks: true,
    restoreMocks: true,
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:\.bun[\\/])?(?:react|react-dom|scheduler)/,
              priority: 3,
            },
            {
              name: "farcaster-sdk",
              test: /node_modules[\\/](?:\.bun[\\/])?@farcaster[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
});
