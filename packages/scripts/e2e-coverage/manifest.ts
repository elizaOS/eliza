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
  "packages/agent/src/__tests__/plugin-view-inventory-ratchet.test.ts",
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

/**
 * Coverage for the #8791 pre-LLM shortcut registry. The slash-command shortcuts
 * (`createCommandShortcuts` → `<KEY>_COMMAND` action targets) are exercised
 * end-to-end against a real `AgentRuntime`: the commands plugin's
 * `Plugin.shortcuts` wire into `runtime.shortcutRegistry`, and `runShortcutGate`
 * resolves deterministic replies through the real pre-LLM gate with no model
 * call. `command-actions.test.ts` snapshots every concrete
 * `<shortcut-id>:<alias>-><action>` signature; inventory.ts adds the relevant
 * signature as a per-shortcut signal so the matrix cannot collapse all shortcuts
 * into one generic covered row.
 */
export const SHORTCUT_COVERAGE: CoverageEntry = {
  status: "covered",
  artifacts: [
    "plugins/plugin-commands/__tests__/command-actions.test.ts",
    "packages/agent/src/services/commands-shortcut-runtime.test.ts",
    "packages/core/src/services/message.shortcut-gate.test.ts",
    "packages/core/src/runtime/shortcut-registry.test.ts",
  ],
  signals: ["runShortcutGate", "shortcutRegistry"],
  note: "createCommandShortcuts → runtime.shortcutRegistry; runShortcutGate resolves slash shortcuts deterministically through the real gate (no model).",
};

/** New keyless route tests boot the real handler via this prod entry point. */
const REAL_DISPATCH_SIGNAL = "tryHandleRuntimePluginRoute";

function covered(artifact: string, extraSignals: string[] = []): CoverageEntry {
  return {
    status: "covered",
    artifacts: [artifact],
    signals: [REAL_DISPATCH_SIGNAL, ...extraSignals],
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
  "plugin-birdclaw": existing(
    "plugins/plugin-birdclaw/src/routes/birdclaw-routes.test.ts",
  ),
  "plugin-bluebubbles": existing(
    "plugins/plugin-bluebubbles/__tests__/data-routes.test.ts",
  ),
  "plugin-browser": existing(
    "plugins/plugin-browser/src/routes/workspace-routes.test.ts",
  ),
  "plugin-calendar": existing(
    "plugins/plugin-calendar/test/calendar-routes.test.ts",
  ),
  "plugin-documents": existing("plugins/plugin-documents/test/routes.test.ts"),
  "plugin-elizacloud": existing(
    "plugins/plugin-elizacloud/__tests__/cloud-billing-routes.test.ts",
  ),
  "plugin-hyperliquid": existing(
    "plugins/plugin-hyperliquid/src/routes.real.test.ts",
  ),
  "plugin-inbox": existing("plugins/plugin-inbox/test/inbox-routes.test.ts"),
  "plugin-local-inference": existing(
    "plugins/plugin-local-inference/__tests__/voice-models-routes.test.ts",
  ),
  "plugin-meetings": existing(
    "plugins/plugin-meetings/src/routes/meetings-routes.test.ts",
  ),
  "plugin-polymarket": existing(
    "plugins/plugin-polymarket/src/routes.real.test.ts",
  ),
  "plugin-signal": existing("plugins/plugin-signal/src/setup-routes.test.ts"),
  "plugin-scheduling": existing(
    "plugins/plugin-scheduling/src/routes/scheduled-tasks.test.ts",
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
  "plugin-facewear": covered(
    "plugins/plugin-facewear/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-github": covered("plugins/plugin-github/src/routes-e2e.test.ts"),
  "plugin-imessage": covered("plugins/plugin-imessage/src/routes-e2e.test.ts"),
  "plugin-music": covered(
    "plugins/plugin-music/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-telegram": covered("plugins/plugin-telegram/src/routes-e2e.test.ts"),
  "plugin-workflow": covered(
    "plugins/plugin-workflow/__tests__/integration/routes-e2e.test.ts",
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
  "plugin-vision": {
    status: "exempt",
    reason:
      "vision's HTTP routes (/api/vision/capture-requests, /api/vision/screen-frame) are a renderer↔agent screen-capture bridge queue backed by ScreenCaptureBridgeService; they only drain/settle in-process capture requests against a live on-device screen-capture + vision backend (verified on Pixel 9a in #9105/#9356) and have no deterministic keyless fixture, so a keyless route e2e cannot stand them up.",
  },
};

/**
 * Plugins that ship with no test file at all (`discoverZeroTestPlugins`) yet are
 * intentionally test-exempt, each with a written justification. Issue #8802
 * requires every zero-test plugin to either gain a real test or be listed here;
 * a newly added zero-test plugin that is not listed fails the gate.
 *
 * Currently empty: every plugin under `plugins/` ships at least one test.
 * `plugin-tee` and `plugin-native-shared-types` gained real tests (#9991);
 * `plugin-action-bench` and `plugin-xmtp` were vestigial `bun.lock`-only
 * directories left by the v2.0.4 baseline squash (action-bench's runtime lives
 * in plugin-training; xmtp had no source) and were removed (#9943). Keep this
 * map empty unless a genuinely untestable plugin lands — never paper a missing
 * test with an exemption.
 */
export const ZERO_TEST_EXEMPT: Record<string, string> = {};
