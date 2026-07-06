/** Configures the e2e shared Vitest lane used by workspace package tests. */
import path from "node:path";
import { defineConfig } from "vitest/config";
import baseConfig from "./real.config";
import { repoRoot } from "./repo-root";
import { getElizaWorkspaceRoot } from "./workspace-aliases";

// These lanes run from two layouts: the flat elizaOS monorepo (workspace ==
// repo root) and consumer repos that embed it as an `eliza/` subdirectory.
// Paths are authored workspace-relative and remapped against the resolved
// workspace root so the same globs match in both layouts (in the embedded
// layout this yields the historical `eliza/…` prefix; in the flat layout the
// prefix drops away instead of matching zero files).
const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const elizaWorkspacePattern = (relativePath: string) =>
  path
    .relative(
      repoRoot,
      path.join(elizaWorkspaceRoot, ...relativePath.split("/")),
    )
    .split(path.sep)
    .join("/");

export const heavyOnlyE2EPaths = [
  "packages/app-core/test/app/memory-relationships.real.e2e.test.ts",
  "packages/app-core/test/app/qa-checklist.real.e2e.test.ts",
  "packages/app-core/src/services/local-inference/engine.e2e.test.ts",
  "packages/ui/src/services/local-inference/engine.e2e.test.ts",
].map(elizaWorkspacePattern);

export const checkoutDependentE2EPaths = [
  // These suites depend on the coding-agent coordinator surface and are run
  // via the focused coding-agent lane instead of the default deterministic E2E
  // matrix.
  "plugins/plugin-task-coordinator/test/coding-agent-codex-artifact.live.e2e.test.ts",
  "plugins/plugin-task-coordinator/test/quicksort-coding-agent.live.e2e.test.ts",
].map(elizaWorkspacePattern);

export const specializedLiveE2EPaths = [
  // Feature-specific lanes that require extra live env flags, long-running
  // setup, or dedicated orchestration to avoid baseline E2E skips.
  "plugins/plugin-personal-assistant/test/assistant-user-journeys.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-calendar-chat.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-chat.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-gmail-chat.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-memory.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/selfcontrol-chat.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/selfcontrol-desktop.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/selfcontrol-dev.live.e2e.test.ts",
  "plugins/plugin-documents/test/documents-api.live.e2e.test.ts",
  "packages/app-core/test/live-agent/action-invocation.live.e2e.test.ts",
  "packages/app-core/test/live-agent/agent-runtime.live.e2e.test.ts",
  "packages/app-core/test/live-agent/cloud-auth.live.e2e.test.ts",
  "packages/app-core/test/live-agent/cloud-providers.live.e2e.test.ts",
  "packages/app-core/test/live-agent/database-conversation.live.e2e.test.ts",
  "packages/app-core/test/live-agent/experience-extraction.live.e2e.test.ts",
  "packages/app-core/test/live-agent/personality-routing.live.e2e.test.ts",
  "packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts",
  "packages/app-core/test/live-agent/runtime-debug.live.e2e.test.ts",
].map(elizaWorkspacePattern);

export const credentialDependentE2EPaths = [
  // Optional connector / wallet coverage needs real third-party credentials.
  // Keep these out of the baseline lane so it does not silently pass with skips.
  "packages/app-core/test/live-agent/connector-health.live.e2e.test.ts",
  "packages/app-core/test/live-agent/farcaster-connector.live.e2e.test.ts",
  "packages/app-core/test/live-agent/feishu-connector.live.e2e.test.ts",
  "packages/app-core/test/live-agent/lens-connector.live.e2e.test.ts",
  "packages/app-core/test/live-agent/matrix-connector.live.e2e.test.ts",
  "packages/app-core/test/live-agent/nostr-connector.live.e2e.test.ts",
  "packages/app-core/test/live-agent/telegram-connector.live.e2e.test.ts",
].map(elizaWorkspacePattern);

export const vitestE2EInclude = [
  "apps/**/*.e2e.test.{ts,tsx}",
  "packages/**/*.e2e.test.{ts,tsx}",
  "plugins/**/*.e2e.test.{ts,tsx}",
].map(elizaWorkspacePattern);

export const baselineE2EExcludedPaths = [
  ...heavyOnlyE2EPaths,
  ...checkoutDependentE2EPaths,
  ...specializedLiveE2EPaths,
  ...credentialDependentE2EPaths,
];

export const nonVitestE2EExcludedPaths = [
  // Bun test and Playwright suites are executed by package/cloud scripts.
  "plugins/plugin-workflow/__tests__/e2e/**/*.e2e.test.ts",
  "packages/elizaos/templates/**",
  ".claude/**",
].map(elizaWorkspacePattern);

export const liveAndRealE2EInclude = vitestE2EInclude;

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: vitestE2EInclude,
    exclude: [
      ...(baseConfig.test?.exclude ?? []),
      ...nonVitestE2EExcludedPaths,
      ...baselineE2EExcludedPaths,
    ],
  },
});
