import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    include: [
      "src/__tests__/task-agent-live.e2e.test.ts",
      "src/__tests__/coding-task-launch-failure-message.test.ts",
      "src/__tests__/task-agent-frameworks.test.ts",
      "src/__tests__/skill-manifest.test.ts",
      "src/__tests__/skill-recommender.test.ts",
      "src/__tests__/skill-callback.test.ts",
      "src/__tests__/manage-issues-oauth.test.ts",
      "src/__tests__/custom-validator-runner.test.ts",
      "src/__tests__/structured-proof-bridge.test.ts",
      "src/__tests__/parent-context-routes.test.ts",
      "src/__tests__/split-multi-intent.test.ts",
      "src/__tests__/pr39-followups.test.ts",
      "src/__tests__/ansi-utils.test.ts",
      "src/__tests__/swarm-decision-loop.test.ts",
      "src/__tests__/swarm-idle-watchdog.test.ts",
      "src/__tests__/task-agent-auth.test.ts",
      "src/__tests__/pty-spawn-path-fallback.test.ts",
      "src/__tests__/pty-auto-response.test.ts",
      "src/__tests__/pty-service-spawn-model-prefs.test.ts",
      "src/__tests__/spawn-trajectory.test.ts",
      "src/__tests__/spawn-route-shell-register.test.ts",
      "src/__tests__/resolve-default-branch.test.ts",
      "src/__tests__/env-allowlist.test.ts",
    ],
  },
});
