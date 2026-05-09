/**
 * Vitest config for the live/real suite only.
 *
 * This config deliberately avoids the default unit/e2e stub graph and includes
 * only files that are already marked `live` or `real`.
 *
 * Browser-driven QA flows stay out of this baseline config. Dedicated
 * live/e2e lanes cover browser and long-running orchestration scenarios so the
 * required CI real suite stays focused on repo-supported non-mock integration
 * coverage.
 *
 * `bun run test:ci:real` sets `ELIZA_CI_REAL=1`, which additionally excludes
 * upstream-only or credential-gated real tests that Eliza does not provision
 * in its required PR workflow.
 */

import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  getAppCoreSourceRoot,
  getAutonomousSourceRoot,
  getElizaCoreEntry,
  getSharedSourceRoot,
  getUiSourceRoot,
} from "../eliza-package-paths";
import { repoRoot } from "./repo-root";
import {
  getAgentSourceAliases,
  getAppCoreSourceAliases,
  getElizaCoreRolesEntry,
  getElizaWorkspaceRoot,
  getOptionalInstalledPackageAliases,
  getOptionalPluginSdkAliases,
  getSharedSourceAliases,
  getUiSourceAliases,
  getWorkspaceAppAliases,
  type ModuleAlias,
} from "./workspace-aliases";

const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const disabledElizaWorkspaceRoot = path.join(repoRoot, ".eliza.ci-disabled");
const hiddenElizaWorkspaceGlob =
  fs.existsSync(elizaWorkspaceRoot) && fs.existsSync(disabledElizaWorkspaceRoot)
    ? ".eliza.ci-disabled/**"
    : undefined;
const isCiReal = process.env.ELIZA_CI_REAL === "1";
const elizaWorkspacePattern = (relativePath: string) =>
  path
    .relative(
      repoRoot,
      path.join(elizaWorkspaceRoot, ...relativePath.split("/")),
    )
    .split(path.sep)
    .join("/");
const ciExcludedRealPaths = [
  // ComputerUseService.loadConfig unconditionally calls setBrowserRuntimeOptions({
  // headless: false}), overriding the module-level CI headless detection from
  // browser.ts. This causes browser_connect to fail on headless CI runners when
  // Chrome is installed but there is no display. Fix requires an update to
  // eliza/plugins/plugin-computeruse/src/services/computer-use-service.ts to
  // only call setBrowserRuntimeOptions when COMPUTER_USE_BROWSER_HEADLESS is
  // explicitly set.
  elizaWorkspacePattern(
    "plugins/plugin-computeruse/src/__tests__/computeruse.real.test.ts",
  ),
  // These surfaces are covered by dedicated workflows or upstream package
  // suites instead of Eliza's required PR real-test lane.
  elizaWorkspacePattern(
    "packages/app-core/test/app/onboarding-companion.live.e2e.test.ts",
  ),
  elizaWorkspacePattern("packages/benchmarks/app-eval/evaluate.real.test.ts"),
  elizaWorkspacePattern(
    "plugins/plugin-form/src/tests/toon-integration.live.test.ts",
  ),
  elizaWorkspacePattern(
    "plugins/app-lifeops/test/lifeops-life-chat.real.test.ts",
  ),
  elizaWorkspacePattern(
    "plugins/app-lifeops/test/lifeops-llm-extraction.live.test.ts",
  ),
  elizaWorkspacePattern(
    "packages/agent/src/providers/media-provider.real.test.ts",
  ),
  elizaWorkspacePattern(
    "packages/agent/src/actions/life-param-extractor-real.test.ts",
  ),
  elizaWorkspacePattern(
    "plugins/plugin-wallet/src/chains/evm/__tests__/integration/rpc-providers.live.test.ts",
  ),
  elizaWorkspacePattern(
    "plugins/plugin-wallet/src/chains/evm/__tests__/integration/transfer.live.test.ts",
  ),
  elizaWorkspacePattern("plugins/plugin-shell/__tests__/shell.real.test.ts"),
  // plugin-openrouter sdk nested workspace deps don't resolve in this CI lane.
  elizaWorkspacePattern(
    "plugins/plugin-openrouter/__tests__/models.live.test.ts",
  ),
];
const liveSetupFile = [
  path.join(
    elizaWorkspaceRoot,
    "packages",
    "app-core",
    "test",
    "live.setup.ts",
  ),
  path.join(
    disabledElizaWorkspaceRoot,
    "packages",
    "app-core",
    "test",
    "live.setup.ts",
  ),
].find((candidate) => fs.existsSync(candidate));

const elizaCoreEntry = getElizaCoreEntry(repoRoot);
const elizaCoreRolesEntry = getElizaCoreRolesEntry(repoRoot);
const elizaCoreSourceRoot = path.join(elizaWorkspaceRoot, "packages", "core", "src");
const autonomousSourceRoot = getAutonomousSourceRoot(repoRoot);
const appCoreSourceRoot = getAppCoreSourceRoot(repoRoot);
const sharedSourceRoot = getSharedSourceRoot(repoRoot);
const workspaceUiSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages",
  "ui",
  "src",
);
const uiSourceRoot = fs.existsSync(path.join(workspaceUiSourceRoot, "index.ts"))
  ? workspaceUiSourceRoot
  : getUiSourceRoot(repoRoot);
const pluginOpenAiRoot = path.join(elizaWorkspaceRoot, "plugins", "plugin-openai");
const pluginIMessageRoot = path.join(elizaWorkspaceRoot, "plugins", "plugin-imessage");
const pluginDiscordRoot = path.join(elizaWorkspaceRoot, "plugins", "plugin-discord");
const pluginBrowserRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-browser",
  "src",
);
const pluginElizaCloudRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-elizacloud",
  "src",
);
const appCompanionSourceRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "app-companion",
  "src",
);
const appStewardSourceRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "app-steward",
  "src",
);
const appTrainingSourceRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "app-training",
  "src",
);
const liveRetryCount = process.env.ELIZA_LIVE_TEST === "1" ? 1 : 0;
process.env.ELIZA_LIVE_TEST = "1";

const realResolveAlias: ModuleAlias[] = [
  ...getOptionalPluginSdkAliases(repoRoot),
  {
    find: "@elizaos/core/roles",
    replacement: elizaCoreRolesEntry,
  },
  {
    find: /^@elizaos\/core\/(.+)/,
    replacement: path.join(elizaCoreSourceRoot, "$1"),
  },
  ...(elizaCoreEntry
    ? [
        {
          find: "@elizaos/core",
          replacement: elizaCoreEntry,
        },
      ]
    : []),
  ...getAgentSourceAliases(autonomousSourceRoot, {
    includeElizaAlias: true,
  }),
  ...getAppCoreSourceAliases(appCoreSourceRoot),
  ...getUiSourceAliases(uiSourceRoot),
  {
    find: "@elizaos/app-lifeops/plugin",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "app-lifeops",
      "src",
      "plugin.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-openai$/,
    replacement: path.join(pluginOpenAiRoot, "index.node.ts"),
  },
  {
    find: /^@elizaos\/plugin-openai\/(.+)$/,
    replacement: path.join(pluginOpenAiRoot, "$1"),
  },
  {
    find: /^@elizaos\/plugin-imessage$/,
    replacement: path.join(pluginIMessageRoot, "src", "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-imessage\/(.+)$/,
    replacement: path.join(pluginIMessageRoot, "src", "$1"),
  },
  {
    find: /^@elizaos\/plugin-browser$/,
    replacement: path.join(pluginBrowserRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-browser\/(.+)$/,
    replacement: path.join(pluginBrowserRoot, "$1"),
  },
  {
    find: /^@elizaos\/plugin-elizacloud$/,
    replacement: path.join(pluginElizaCloudRoot, "index.node.ts"),
  },
  {
    find: /^@elizaos\/plugin-elizacloud\/(.+)$/,
    replacement: path.join(pluginElizaCloudRoot, "$1"),
  },
  {
    find: /^@elizaos\/plugin-discord$/,
    replacement: path.join(pluginDiscordRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-discord\/(.+)$/,
    replacement: path.join(pluginDiscordRoot, "$1"),
  },
  ...getWorkspaceAppAliases(repoRoot, [
    "app-lifeops",
    "app-documents",
    "app-task-coordinator",
    "app-companion",
    "app-shopify",
    "app-steward",
    "app-training",
    "app-vincent",
  ]),
  {
    find: /^@elizaos\/app-companion\/(.*)/,
    replacement: path.join(appCompanionSourceRoot, "$1"),
  },
  {
    find: "@elizaos/app-companion/plugin",
    replacement: path.join(appCompanionSourceRoot, "plugin.ts"),
  },
  {
    find: "@elizaos/app-companion",
    replacement: path.join(appCompanionSourceRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/app-steward\/routes\/(.*)/,
    replacement: path.join(appStewardSourceRoot, "routes", "$1.ts"),
  },
  {
    find: /^@elizaos\/app-steward\/api\/(.*)/,
    replacement: path.join(appStewardSourceRoot, "api", "$1.ts"),
  },
  {
    find: /^@elizaos\/app-steward\/(.*)/,
    replacement: path.join(appStewardSourceRoot, "$1"),
  },
  {
    find: "@elizaos/app-steward",
    replacement: path.join(appStewardSourceRoot, "index.ts"),
  },
  {
    find: "@elizaos/app-training/routes/training",
    replacement: path.join(appTrainingSourceRoot, "routes", "training-routes.ts"),
  },
  {
    find: "@elizaos/app-training/routes/trajectory",
    replacement: path.join(
      appTrainingSourceRoot,
      "routes",
      "trajectory-routes.ts",
    ),
  },
  {
    find: /^@elizaos\/app-training\/services\/(.*)/,
    replacement: path.join(appTrainingSourceRoot, "services", "$1.ts"),
  },
  {
    find: "@elizaos/app-training/services",
    replacement: path.join(appTrainingSourceRoot, "services", "index.ts"),
  },
  {
    find: /^@elizaos\/app-training\/core\/(.*)/,
    replacement: path.join(appTrainingSourceRoot, "core", "$1.ts"),
  },
  {
    find: /^@elizaos\/app-training\/(.*)/,
    replacement: path.join(appTrainingSourceRoot, "$1"),
  },
  {
    find: "@elizaos/app-training",
    replacement: path.join(appTrainingSourceRoot, "index.ts"),
  },
  {
    find: "@elizaos/app-documents/routes",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "app-documents",
      "src",
      "routes.ts",
    ),
  },
  {
    find: "@elizaos/app-documents/service-loader",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "app-documents",
      "src",
      "service-loader.ts",
    ),
  },
  {
    find: /^@elizaos\/app-documents\/(.*)/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "app-documents",
      "src",
      "$1",
    ),
  },
  {
    find: "@elizaos/app-documents",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "app-documents",
      "src",
      "index.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-form\/(.*)/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-form",
      "src",
      "$1",
    ),
  },
  {
    find: "@elizaos/plugin-form",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-form",
      "src",
      "index.ts",
    ),
  },
  ...getSharedSourceAliases(sharedSourceRoot, {
    includeConfigAlias: true,
    includeElizaAlias: true,
  }),
  // P0 auth subsystem reads tables/types from plugin-sql; map subpaths to
  // source so vitest's resolver doesn't fall through to the dist `main`.
  // Subpaths first (Vite alias matching is order-sensitive).
  {
    find: "@elizaos/plugin-sql/schema",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-sql",
      "typescript",
      "schema",
      "index.ts",
    ),
  },
  {
    find: "@elizaos/plugin-sql/types",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-sql",
      "typescript",
      "types.ts",
    ),
  },
  {
    find: "@elizaos/plugin-sql/drizzle",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-sql",
      "typescript",
      "drizzle",
      "index.ts",
    ),
  },
  // Bare-package alias to source so the runtime migrator sees the same
  // `Plugin.schema` namespace the auth-store imports from. Without this
  // the dist build would ship the pre-P0 schema and `auth_identities`
  // would never be created at runtime in tests.
  {
    find: /^@elizaos\/plugin-sql$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-sql",
      "typescript",
      "index.ts",
    ),
  },
  ...getOptionalInstalledPackageAliases(repoRoot, [
    {
      find: "@elizaos/plugin-agent-orchestrator",
      packageName: "@elizaos/plugin-agent-orchestrator",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-agent-orchestrator",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-agent-skills",
      packageName: "@elizaos/plugin-agent-skills",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-agent-skills",
          "typescript",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-commands",
      packageName: "@elizaos/plugin-commands",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-commands",
          "typescript",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-sql",
      packageName: "@elizaos/plugin-sql",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-sql",
          "typescript",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-local-embedding",
      packageName: "@elizaos/plugin-local-embedding",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-local-embedding",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-discord",
      packageName: "@elizaos/plugin-discord",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-discord",
          "typescript",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-telegram/account-auth-service",
      packageName: "@elizaos/plugin-telegram",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-telegram",
          "src",
          "account-auth-service",
        ),
      },
    },
    {
      find: "@elizaos/plugin-telegram",
      packageName: "@elizaos/plugin-telegram",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-telegram",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-openai",
      packageName: "@elizaos/plugin-openai",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-openai",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-anthropic",
      packageName: "@elizaos/plugin-anthropic",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-anthropic",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-google-genai",
      packageName: "@elizaos/plugin-google-genai",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-google-genai",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-groq",
      packageName: "@elizaos/plugin-groq",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-groq",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-ollama",
      packageName: "@elizaos/plugin-ollama",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-ollama",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-openrouter",
      packageName: "@elizaos/plugin-openrouter",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-openrouter",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-elizacloud",
      packageName: "@elizaos/plugin-elizacloud",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-elizacloud",
          "typescript",
          "index.node",
        ),
      },
    },
  ]),
];

export default defineConfig({
  resolve: {
    alias: realResolveAlias,
  },
  test: {
    testTimeout: 300_000,
    hookTimeout: 300_000,
    retry: liveRetryCount,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    sequence: {
      concurrent: false,
      shuffle: false,
    },
    restoreMocks: false,
    clearMocks: false,
    mockReset: false,
    execArgv: ["--max-old-space-size=4096"],
    setupFiles: [
      ...(liveSetupFile ? [liveSetupFile] : []),
      path.join(
        elizaWorkspaceRoot,
        "test",
        "vitest",
        "fail-on-silent-skip.setup.ts",
      ),
    ],
    include: [
      "**/*.live.test.ts",
      "**/*.live.test.tsx",
      "**/*-live.test.ts",
      "**/*-live.test.tsx",
      "**/*.real.test.ts",
      "**/*.real.test.tsx",
      "**/*-real.test.ts",
      "**/*-real.test.tsx",
    ],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      ".claude/**",
      ...(hiddenElizaWorkspaceGlob ? [hiddenElizaWorkspaceGlob] : []),
      // The default real/live lane only uses public chains. Local Anvil coverage
      // stays out of bun run test until it is replaced with public-chain tests.
      elizaWorkspacePattern(
        "plugins/app-steward/test/anvil-contracts.real.e2e.test.ts",
      ),
      elizaWorkspacePattern("packages/app-core/platforms/electrobun/**"),
      "apps/chrome-extension/**",
      elizaWorkspacePattern("cloud/**"),
      ...(isCiReal ? ciExcludedRealPaths : []),
    ],
    server: {
      deps: {
        inline: [
          "@elizaos/core",
          "@elizaos/agent",
          "@elizaos/app-core",
          /^@elizaai\/shared/,
          /^@elizaos\/plugin-/,
          "zod",
        ],
      },
    },
  },
});
