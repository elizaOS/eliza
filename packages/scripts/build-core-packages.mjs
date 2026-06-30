/**
 * The "core" build set — the leaf workspace packages that the test lanes
 * (`test:server`, `test:client`, `test:plugins`) and several CI/deploy workflows
 * need built before they run. Single source of truth for the root `build:core`
 * script (issue #10200).
 *
 * This list used to live inline in `package.json` as a ~1.9 KB
 * `--filter=@elizaos/… (×27)` string that any new test-lane dependency had to be
 * appended to by hand, and that a renamed/removed package would rot silently.
 * Moving it here makes the set auditable (grouped + one name per line) and lets
 * `build-core.test.ts` guard it against drift — every entry must resolve to a
 * real workspace package, or the test fails loudly.
 *
 * Each name is a *leaf* target: Turbo's `build` task is `dependsOn: ["^build"]`,
 * so requesting a package here automatically builds its full workspace-dependency
 * closure. List only the packages a test lane imports directly — not their
 * transitive dependencies.
 */
export const CORE_BUILD_PACKAGES = [
  // Framework + shared runtime every server/client lane imports.
  "@elizaos/contracts",
  "@elizaos/core",
  "@elizaos/shared",
  "@elizaos/ui",
  "@elizaos/app-core",
  "@elizaos/vault",

  // Cloud libraries the cloud + app test lanes import directly.
  "@elizaos/cloud-sdk",
  "@elizaos/cloud-routing",
  "@elizaos/cloud-shared",

  // Model-provider plugins exercised by the runtime + scenario lanes.
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-local-inference",

  // Agent capability plugins exercised by the server/plugin test lanes.
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-app-manager",
  "@elizaos/plugin-background-runner",
  "@elizaos/plugin-calendar",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-shell",
  "@elizaos/plugin-task-coordinator",
  "@elizaos/plugin-training",
  "@elizaos/plugin-video",
  "@elizaos/plugin-wallet",
  "@elizaos/plugin-worker-runtime",
  "@elizaos/plugin-x402",
];
