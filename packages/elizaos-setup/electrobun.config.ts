import { defineConfig } from "electrobun";

export default defineConfig({
  app: {
    name: "elizaOS AOSP Flasher",
    identifier: "ai.elizaos.aosp-flasher",
    version: "1.0.0",
  },
  build: {
    entry: "src/index.ts",
    frontend: {
      root: ".",
      distDir: "dist",
      devCommand: "bun run dev",
      buildCommand: "bun run build",
    },
    output: "build/",
  },
  platforms: {
    macos: {},
    linux: {},
    windows: {},
  },
});
