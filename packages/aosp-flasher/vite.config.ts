import { defineConfig } from "vite";

export default defineConfig({
  plugins: [],
  server: {
    port: 5175,
    proxy: {
      "/api": {
        target: "http://localhost:3743",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
