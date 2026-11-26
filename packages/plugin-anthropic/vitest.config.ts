import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({ plugins: [vibelang()], resolve: { dedupe: ["vitest"] }, test: { server: { deps: { inline: ["@effect/vitest"] } }, include: ["test/**/*.test.{ts,tsx,vibe}"], passWithNoTests: true, sequence: { shuffle: false, seed: 1 }, retry: 0, testTimeout: 60_000, hookTimeout: 60_000 } })
