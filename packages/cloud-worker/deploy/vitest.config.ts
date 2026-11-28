// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["deploy/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
})
