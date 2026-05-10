import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/solana-gym-env/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:\.bun[\\/])?(?:react|react-dom|scheduler)/,
              priority: 4,
            },
            {
              name: "charts",
              test: /node_modules[\\/](?:\.bun[\\/])?(?:recharts|d3-|victory-vendor)/,
              priority: 3,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](?:\.bun[\\/])?(?:react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|vfile)/,
              priority: 2,
            },
            {
              name: "router",
              test: /node_modules[\\/](?:\.bun[\\/])?react-router/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
  },
});
