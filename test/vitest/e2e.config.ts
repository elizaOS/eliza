import { defineConfig } from "vitest/config";
import baseConfig from "./real.config";

export const heavyOnlyE2EPaths = [
  "eliza/plugins/app-steward/test/anvil-contracts.real.e2e.test.ts",
  "eliza/packages/app-core/test/app/memory-relationships.real.e2e.test.ts",
  "eliza/packages/app-core/test/app/onboarding-companion.live.e2e.test.ts",
  "eliza/packages/app-core/test/app/qa-checklist.real.e2e.test.ts",
];

export const checkoutDependentE2EPaths = [
  // These suites depend on the coding-agent coordinator surface and are run
  // via the focused coding-agent lane instead of the default deterministic E2E
  // matrix.
  "eliza/plugins/app-task-coordinator/test/coding-agent-codex-artifact.live.e2e.test.ts",
  "eliza/plugins/app-task-coordinator/test/quicksort-coding-agent.live.e2e.test.ts",
];

export const specializedLiveE2EPaths = [
  // Feature-specific lanes that require extra live env flags, long-running
  // setup, or dedicated orchestration to avoid baseline E2E skips.
  "eliza/plugins/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/lifeops-calendar-chat.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/lifeops-chat.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/lifeops-gmail-chat.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/lifeops-memory.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/selfcontrol-chat.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/selfcontrol-desktop.live.e2e.test.ts",
  "eliza/plugins/app-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
  "eliza/plugins/app-documents/test/documents-live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/action-invocation.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/agent-runtime.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/cloud-auth.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/cloud-providers.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/database-conversation.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/experience-extraction.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/n8n-sidecar.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/personality-routing.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/runtime-debug.live.e2e.test.ts",
];

export const credentialDependentE2EPaths = [
  // Optional connector / wallet coverage needs real third-party credentials.
  // Keep these out of the baseline lane so it does not silently pass with skips.
  "eliza/plugins/app-steward/test/wallet-live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/connector-health.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/farcaster-connector.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/feishu-connector.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/lens-connector.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/matrix-connector.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/nostr-connector.live.e2e.test.ts",
  "eliza/packages/app-core/test/live-agent/telegram-connector.live.e2e.test.ts",
];

export const liveAndRealE2EInclude = [
  "eliza/apps/**/*.{live,real}.e2e.test.{ts,tsx}",
  "eliza/apps/**/*-{live,real}.e2e.test.{ts,tsx}",
  "eliza/packages/**/*.{live,real}.e2e.test.{ts,tsx}",
  "eliza/packages/**/*-{live,real}.e2e.test.{ts,tsx}",
];

export const baselineE2EExcludedPaths = [
  ...heavyOnlyE2EPaths,
  ...checkoutDependentE2EPaths,
  ...specializedLiveE2EPaths,
  ...credentialDependentE2EPaths,
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: liveAndRealE2EInclude,
    exclude: [...(baseConfig.test?.exclude ?? []), ...baselineE2EExcludedPaths],
  },
});
