import vibelang from "vibelang-vite";
import { defineConfig } from "vitest/config";

// The defaults of vibestack/testing/vitest.ts, which `spec init` uses, for a project that does not install the tools.
export default defineConfig({
  plugins: [vibelang()],
  test: {
    include: ["test/**/*.test.{ts,tsx,vibe}", "generated/stories/stories.test.tsx"],
    passWithNoTests: true,
    sequence: { shuffle: false, seed: 1 },
    retry: 0,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
