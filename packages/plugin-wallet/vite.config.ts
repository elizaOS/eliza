// spec/wallet/index.md, "Story: Preview an exact wallet operation before executing it"
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import vibelang from "vibelang-vite";

const project = resolve(import.meta.dirname, "tsconfig.build.json");

export default defineConfig({
  plugins: [vibelang({ project }), tailwindcss()],
  build: {
    outDir: "dist/review",
    lib: {
      entry: resolve(import.meta.dirname, "src/review.tsx"),
      cssFileName: "wallet-review",
      fileName: "wallet-review",
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "effect"],
    },
  },
});
