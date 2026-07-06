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
  getElizaWorkspaceRoot,
  getOptionalInstalledPackageAliases,
  getOptionalPluginSdkAliases,
  getSharedSourceAliases,
  getUiSourceAliases,
  getWorkspaceAppAliases,
  getWorkspacePluginAliases,
  type ModuleAlias,
} from "./workspace-aliases";

const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const failOnSilentSkipSetupFile = fs.existsSync(
  path.join(
    elizaWorkspaceRoot,
    "packages",
    "test",
    "vitest",
    "fail-on-silent-skip.setup.ts",
  ),
)
  ? path.join(
      elizaWorkspaceRoot,
      "packages",
      "test",
      "vitest",
      "fail-on-silent-skip.setup.ts",
    )
  : path.join(repoRoot, "test", "vitest", "fail-on-silent-skip.setup.ts");
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
  elizaWorkspacePattern("packages/benchmarks/app-eval/evaluate.real.test.ts"),
  elizaWorkspacePattern(
    "plugins/plugin-form/src/tests/json-integration.live.test.ts",
  ),
  elizaWorkspacePattern(
    "plugins/plugin-personal-assistant/test/lifeops-life-chat.real.test.ts",
  ),
  elizaWorkspacePattern(
    "plugins/plugin-personal-assistant/test/lifeops-llm-extraction.live.test.ts",
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
const elizaCoreEntryDir = elizaCoreEntry
  ? path.dirname(elizaCoreEntry)
  : undefined;
// Exact-match aliases for the `@elizaos/core/<subpath>` exports this lane's
// module graph imports (`./node` from plugin dists, `./testing` from the test
// harness, `./connectors` from connector plugins). A bare-string
// "@elizaos/core" alias is prefix-matched by Vite/rollup and rewrites those
// subpaths into "<core entry file>/<subpath>" (a path under a *file*), which
// kills any suite whose plugin graph imports them (#11047) — mirror
// integration.config.ts instead.
const elizaCoreSubpathAliases: ModuleAlias[] = elizaCoreEntryDir
  ? [
      { subpath: "node", candidates: ["index.node.ts", "index.node.js"] },
      {
        subpath: "testing",
        candidates: ["testing/index.ts", "../testing/index.js"],
      },
      {
        subpath: "connectors",
        candidates: ["connectors.ts", "../connectors.js"],
      },
    ].flatMap(({ subpath, candidates }) => {
      const replacement = candidates
        .map((candidate) => path.join(elizaCoreEntryDir, candidate))
        .find((candidate) => fs.existsSync(candidate));
      return replacement
        ? [{ find: new RegExp(`^@elizaos/core/${subpath}$`), replacement }]
        : [];
    })
  : [];
const autonomousSourceRoot = getAutonomousSourceRoot(repoRoot);
const appCoreSourceRoot = getAppCoreSourceRoot(repoRoot);
const sharedSourceRoot = getSharedSourceRoot(repoRoot);
const vaultSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages",
  "vault",
  "src",
);
const cloudSdkSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages",
  "cloud-sdk",
  "src",
);
const workspaceUiSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages",
  "ui",
  "src",
);
const uiSourceRoot = fs.existsSync(path.join(workspaceUiSourceRoot, "index.ts"))
  ? workspaceUiSourceRoot
  : getUiSourceRoot(repoRoot);
const pluginOpenAiRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-openai",
);
const pluginGoogleRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-google",
  "src",
);
const pluginIMessageRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-imessage",
);
const pluginDiscordRoot = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-discord",
);
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
const liveRetryCount = process.env.ELIZA_LIVE_TEST === "1" ? 1 : 0;
process.env.ELIZA_LIVE_TEST = "1";

const realResolveAlias: ModuleAlias[] = [
  ...getOptionalPluginSdkAliases(repoRoot),
  ...(elizaCoreEntry
    ? [
        // Subpath aliases must precede the bare specifier (see the note on
        // elizaCoreSubpathAliases above). The bare specifier is exact-matched
        // so any other subpath falls through to package-exports resolution.
        ...elizaCoreSubpathAliases,
        {
          find: /^@elizaos\/core$/,
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
    find: "@elizaos/vault",
    replacement: path.join(vaultSourceRoot, "index.ts"),
  },
  {
    find: "@elizaos/cloud-sdk",
    replacement: path.join(cloudSdkSourceRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-openai$/,
    replacement: path.join(pluginOpenAiRoot, "index.node.ts"),
  },
  {
    find: /^@elizaos\/plugin-google$/,
    replacement: path.join(pluginGoogleRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-imessage$/,
    replacement: path.join(pluginIMessageRoot, "src", "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-browser$/,
    replacement: path.join(pluginBrowserRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/plugin-elizacloud$/,
    replacement: path.join(pluginElizaCloudRoot, "index.node.ts"),
  },
  {
    // Same prefix-alias hazard as plugin-discord above: the installed-package
    // string alias rewrites subpath imports (e.g. ./cloud/duffel-client) into
    // dist paths that do not exist. Route them to source like app-core does.
    find: /^@elizaos\/plugin-elizacloud\/(.+)$/,
    replacement: `${pluginElizaCloudRoot.split(path.sep).join("/")}/$1`,
  },
  {
    find: /^@elizaos\/plugin-discord$/,
    replacement: path.join(pluginDiscordRoot, "index.ts"),
  },
  {
    // The installed-package alias below is a bare string, which vite treats as
    // a prefix — subpath imports would rewrite to `dist/index.js/<subpath>`.
    // Pin the one subpath the PA plugin graph imports to source, mirroring
    // integration.config.ts.
    find: /^@elizaos\/plugin-discord\/user-account-scraper$/,
    replacement: path.join(
      pluginDiscordRoot,
      "user-account-scraper",
      "index.ts",
    ),
  },
  {
    // Subpath imports (e.g. @elizaos/plugin-wallet/diagnostic) must resolve to
    // source before the bare string alias below rewrites the package root to
    // src/index.ts; mirrors packages/app-core/vitest.config.ts.
    find: /^@elizaos\/plugin-wallet\/(.+)$/,
    replacement: `${path
      .join(elizaWorkspaceRoot, "plugins", "plugin-wallet", "src")
      .split(path.sep)
      .join("/")}/$1`,
  },
  ...getWorkspaceAppAliases(repoRoot, [
    "app-task-coordinator",
    "plugin-wallet",
  ]),
  ...getWorkspacePluginAliases(repoRoot, [
    "plugin-documents",
    "plugin-personal-assistant",
    "plugin-scheduling",
    "plugin-local-inference",
    "plugin-shopify",
    "plugin-training",
    "plugin-wallet-ui",
    "plugin-x402",
  ]),
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
  {
    find: /^@elizaos\/plugin-sql$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-sql",
      "src",
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
          "src",
          "index.ts",
        ),
      },
    },
    {
      find: "@elizaos/plugin-local-inference",
      packageName: "@elizaos/plugin-local-inference",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-local-inference",
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
      failOnSilentSkipSetupFile,
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
