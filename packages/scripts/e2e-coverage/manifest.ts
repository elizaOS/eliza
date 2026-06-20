/**
 * Coverage manifest for the e2e ship-gate (issue #8802) — the committed source
 * of truth that maps each surface item to the real test artifact(s) that cover
 * it, or records an explicit, justified exemption.
 *
 * Precedent: this is the same curated-set + drift-check pattern as
 * `packages/app/test/route-coverage.test.ts` (DIRECT_ROUTE_CASES) and
 * `view-interaction-coverage.test.ts` (GUI_INTERACTION_OWNERS / INTERACTION_DEBT).
 *
 * Anti-larp: a `covered` entry only counts when every artifact exists AND each
 * declared `signal` appears in at least one artifact. For new plugin-route tests
 * the signal is `tryHandleRuntimePluginRoute` — the real prod dispatch entry —
 * so a mocked-`json`-fn unit test (which never calls it) cannot satisfy the gate.
 * Known shape-only tests are listed in `LARP_TEST_ARTIFACTS` and are rejected
 * outright if cited as coverage.
 */

export interface CoverageEntry {
  status: "covered";
  /** Repo-relative test artifact(s) that exercise the real handler. */
  artifacts: string[];
  /** Strings that must each appear in ≥1 artifact (anti-larp proof). */
  signals: string[];
  note?: string;
}

export interface ExemptEntry {
  status: "exempt";
  /** Written justification for why no keyless e2e is required. */
  reason: string;
  /** Optional supporting test that exists but isn't a keyless route e2e. */
  artifacts?: string[];
}

export type ManifestEntry = CoverageEntry | ExemptEntry;

/**
 * Slash-command coverage is collective: the real-server route test and the
 * deterministic scenario both assert the served catalog is exactly
 * `getConnectorCommands("gui")`, so every command is covered as one contract;
 * the Playwright + overlay specs exercise navigate/client/agent dispatch.
 */
export const COMMAND_COVERAGE: CoverageEntry = {
  status: "covered",
  artifacts: [
    "packages/agent/src/api/commands-routes.real-server.test.ts",
    "packages/scenario-runner/test/scenarios/deterministic-slash-commands.scenario.ts",
    "packages/app/test/ui-smoke/slash-commands.spec.ts",
    "packages/ui/src/components/shell/ContinuousChatOverlay.slash.test.tsx",
  ],
  // The full-catalog contract appears in the real-server test + the scenario;
  // the menu-dispatch path appears in the Playwright + overlay specs.
  signals: ["getConnectorCommands", "slash-command-menu"],
  note: "Served catalog asserted == getConnectorCommands; navigate/client/agent dispatch exercised end to end.",
};

/**
 * Shape-only tests that drive a handler with mocked `json`/`error` functions
 * and never open a socket or call the real dispatcher — they do not count as
 * e2e coverage (issue §6 larp-detection).
 */
export const LARP_TEST_ARTIFACTS: ReadonlySet<string> = new Set([
  "packages/agent/src/api/commands-routes.test.ts",
]);

/**
 * Views are covered by the existing UI ship-gates; this issue references them
 * (#8796/#8797/#8798) rather than re-implementing view e2e. The gate only
 * asserts these gate files still exist (deletion = regression).
 */
export const VIEW_COVERAGE_GATES: readonly string[] = [
  "packages/app/test/route-coverage.test.ts",
  "packages/app/test/view-interaction-coverage.test.ts",
  "packages/agent/src/__tests__/plugin-tui-view-coverage.test.ts",
];

/**
 * Candidate source paths for the #8791 pre-LLM shortcut registry. None exist
 * today, so the shortcut surface is empty and advisory; when #8791 lands at one
 * of these the inventory lights the surface up and the gate requires coverage.
 */
export const SHORTCUT_REGISTRY_HINTS: readonly string[] = [
  "packages/core/src/runtime/shortcut-registry.ts",
  "packages/core/src/shortcuts/index.ts",
  "packages/core/src/runtime/shortcuts/index.ts",
  "plugins/plugin-commands/src/shortcuts.ts",
];

/** New keyless route tests boot the real handler via this prod entry point. */
const REAL_DISPATCH_SIGNAL = "tryHandleRuntimePluginRoute";

function covered(artifact: string, extraSignals: string[] = []): CoverageEntry {
  return {
    status: "covered",
    artifacts: [artifact],
    signals: [REAL_DISPATCH_SIGNAL, ...extraSignals],
  };
}

/** A keyless route e2e that drives routeHandler/Hono production dispatch. */
function coveredByHono(artifact: string): CoverageEntry {
  return {
    status: "covered",
    artifacts: [artifact],
    signals: ["buildHonoAppForRuntime"],
  };
}

/** A pre-existing route test is trusted to exist; deletion is the regression. */
function existing(artifact: string): CoverageEntry {
  return { status: "covered", artifacts: [artifact], signals: [] };
}

/**
 * Every plugin whose exported `Plugin` wires a non-empty `routes` array (the set
 * discovered by `discoverRoutePlugins`). Keys must stay in lock-step with that
 * scan — a newly route-wiring plugin with no entry here fails the gate.
 */
export const PLUGIN_ROUTE_COVERAGE: Record<string, ManifestEntry> = {
  // ── Pre-existing dedicated route tests (trusted; ratcheted against deletion) ─
  "plugin-agent-orchestrator": existing(
    "plugins/plugin-agent-orchestrator/__tests__/unit/agent-routes-goal-wrapper.test.ts",
  ),
  "plugin-bluebubbles": existing(
    "plugins/plugin-bluebubbles/__tests__/data-routes.test.ts",
  ),
  "plugin-browser": existing(
    "plugins/plugin-browser/src/routes/workspace-routes.test.ts",
  ),
  "plugin-documents": existing("plugins/plugin-documents/test/routes.test.ts"),
  "plugin-elizacloud": existing(
    "plugins/plugin-elizacloud/__tests__/cloud-billing-routes.test.ts",
  ),
  "plugin-hyperliquid-app": existing(
    "plugins/plugin-hyperliquid-app/src/routes.real.test.ts",
  ),
  "plugin-local-inference": existing(
    "plugins/plugin-local-inference/__tests__/voice-models-routes.test.ts",
  ),
  "plugin-polymarket-app": existing(
    "plugins/plugin-polymarket-app/src/routes.real.test.ts",
  ),
  "plugin-shopify-ui": existing(
    "plugins/plugin-shopify-ui/src/routes.contract.test.ts",
  ),
  "plugin-signal": existing("plugins/plugin-signal/src/setup-routes.test.ts"),
  "plugin-social-alpha": existing(
    "plugins/plugin-social-alpha/src/routes.test.ts",
  ),
  "plugin-training": existing(
    "plugins/plugin-training/src/routes/trajectory-routes.test.ts",
  ),
  "plugin-wallet": existing("plugins/plugin-wallet/src/plugin.routes.test.ts"),
  "plugin-whatsapp": existing(
    "plugins/plugin-whatsapp/__tests__/webhook-routes.test.ts",
  ),

  // ── New keyless route e2e closing the §3 gap (boot via tryHandleRuntimePluginRoute) ─
  "plugin-computeruse": covered(
    "plugins/plugin-computeruse/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-discord-local": covered(
    "plugins/plugin-discord-local/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-elizamaker": covered(
    "plugins/plugin-elizamaker/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-facewear": covered(
    "plugins/plugin-facewear/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-github": covered("plugins/plugin-github/src/routes-e2e.test.ts"),
  "plugin-imessage": covered("plugins/plugin-imessage/src/routes-e2e.test.ts"),
  "plugin-music": covered(
    "plugins/plugin-music/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-mysticism": covered(
    "plugins/plugin-mysticism/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-telegram": covered("plugins/plugin-telegram/src/routes-e2e.test.ts"),
  "plugin-workflow": covered(
    "plugins/plugin-workflow/__tests__/integration/routes-e2e.test.ts",
  ),
  "plugin-xr": coveredByHono(
    "plugins/plugin-xr/src/__tests__/routes-e2e.test.ts",
  ),

  // ── Exempt with written justification (genuinely covered elsewhere, or need a
  //    live backend that the keyless lane cannot stand up) ─────────────────────
  "plugin-app-control": {
    status: "exempt",
    reason:
      "app-control's HTTP routes are exercised end to end by the deterministic-app-control-actions and deterministic-generated-app-routes api-turn scenarios in the PR lane (real route dispatch over the scenario loopback server).",
    artifacts: [
      "packages/scenario-runner/test/scenarios/deterministic-app-control-actions.scenario.ts",
    ],
  },
  "plugin-personal-assistant": {
    status: "exempt",
    reason:
      "lifeOps HTTP routes are exercised by the live scenario matrix (scenario-matrix.yml lifeops shards) and the plugin-personal-assistant test suite; a keyless route e2e would duplicate that coverage without a deterministic backend.",
  },
  "app-model-tester": {
    status: "exempt",
    reason:
      "model-tester is a dev-only diagnostic surface whose routes proxy live model providers; it has no deterministic fixture and is not shipped in the default agent.",
  },
  "plugin-steward-app": {
    status: "exempt",
    reason:
      "steward-app routes proxy the hosted Steward cloud backend; they require live Steward credentials and have no keyless mock yet (tracked for the e2e-mock-infra issue).",
  },
  "plugin-vincent": {
    status: "exempt",
    reason:
      "vincent routes broker the Lit/Vincent agent-wallet backend over live credentials; no deterministic fixture exists for the keyless lane yet.",
  },
};

/**
 * Plugins that ship with no test file at all (`discoverZeroTestPlugins`). Issue
 * #8802 requires each to either gain a real test or be documented as
 * intentionally test-exempt with a written justification. Every key here is a
 * justification; a newly added zero-test plugin that is not listed fails the
 * gate until it gets a test or an entry. (plugin-discord-local and
 * plugin-elizamaker were on the issue's original list and now have real route
 * tests, so they are deliberately absent here.)
 */
export const ZERO_TEST_EXEMPT: Record<string, string> = {
  "plugin-2004scape":
    "Game-world client surface (RuneScape-era 3D client); no unit-testable logic, exercised through the game-apps Playwright smoke and the unified spatial view framework.",
  "plugin-hyperscape":
    "3D/MMO game-world client surface; rendering + world state are not unit-testable, exercised through the game-apps Playwright smoke.",
  "plugin-scape":
    "Game-world client surface; no headless logic to unit-test, exercised through the game-apps Playwright smoke.",
  "plugin-action-bench":
    "Benchmark/eval harness plugin used to drive scenario benchmarks; it has no shipped runtime behavior to unit-test and runs only under the benchmark lanes.",
  "plugin-google-meet-cute":
    "Experimental Google Meet companion surface gated behind live Google Meet credentials; no deterministic fixture exists.",
  "plugin-local-embedding":
    "Native on-device embedding backend; requires downloaded model weights + native runtime, validated by the local-model validation lane rather than keyless unit tests.",
  "plugin-mlx":
    "Apple MLX native inference backend; requires the MLX framework + model weights on Apple Silicon, validated on-device rather than in keyless CI.",
  "plugin-native-shared-types":
    "Pure shared TypeScript type/contract definitions for the native bridges; there is no runtime behavior to test.",
  "plugin-omnivoice":
    "Native voice (TTS/ASR) backend; requires built native dylibs + voice models, validated by the local-model validation lane rather than keyless CI.",
  "plugin-tee":
    "Trusted-execution (dstack TEE) attestation/key-release; requires real TEE hardware + a dstack socket, validated by the dedicated TEE smoke scripts.",
  "plugin-xmtp":
    "XMTP messaging connector; requires a live XMTP network identity + keys, validated by the live messaging matrix rather than keyless unit tests.",
};
