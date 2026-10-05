/**
 * Coverage manifest for the e2e ship-gate (issue #8802) — the committed source
 * of truth that maps each surface item to the real test artifact(s) that cover
 * it, or records an explicit, justified exemption.
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

/** Known shape-only artifacts cannot satisfy route coverage. */
export const LARP_TEST_ARTIFACTS: ReadonlySet<string> = new Set();

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
  "plugin-assistant": covered(
    "plugins/plugin-assistant/src/routes-e2e.test.ts",
  ),
  // ── Dedicated route tests ──
  "plugin-agent-orchestrator": existing(
    "plugins/plugin-agent-orchestrator/__tests__/unit/agent-routes-goal-wrapper.test.ts",
  ),
  "plugin-browser": existing(
    "plugins/plugin-browser/src/routes/workspace-routes.test.ts",
  ),
  "plugin-calendar": existing(
    "plugins/plugin-calendar/test/calendar-routes.test.ts",
  ),
  "plugin-knowledge": existing("plugins/plugin-knowledge/test/routes.test.ts"),
  "plugin-elizacloud": existing(
    "plugins/plugin-elizacloud/__tests__/cloud-billing-routes.test.ts",
  ),
  "plugin-inbox": existing("plugins/plugin-inbox/test/inbox-routes.test.ts"),
  "plugin-local-inference": {
    status: "exempt",
    reason:
      "Route handlers are exercised against their real catalog and request contracts, but the production dispatch integration requires native model/voice FFI backends that are unavailable in the keyless lane.",
    artifacts: [
      "plugins/plugin-local-inference/src/local-inference-routes.test.ts",
      "plugins/plugin-local-inference/src/routes/local-inference-route-contracts.fuzz.test.ts",
    ],
  },
  "plugin-meetings": existing(
    "plugins/plugin-meetings/src/routes/meetings-routes.test.ts",
  ),
  "plugin-notes": existing(
    "plugins/plugin-notes/src/__tests__/backend.test.ts",
  ),
  "plugin-scheduling": existing(
    "plugins/plugin-scheduling/src/routes/scheduled-tasks.test.ts",
  ),
  "plugin-sql": existing(
    "plugins/plugin-sql/src/__tests__/integration/identity-person-link-attestation.real.test.ts",
  ),
  "plugin-wallet": existing(
    "plugins/plugin-wallet/src/api/wallet-routes.test.ts",
  ),
  "plugin-whatsapp": existing(
    "plugins/plugin-whatsapp/__tests__/webhook-routes.test.ts",
  ),

  // ── New keyless route e2e closing the §3 gap (boot via tryHandleRuntimePluginRoute) ─
  "plugin-computeruse": covered(
    "plugins/plugin-computeruse/src/__tests__/routes-e2e.test.ts",
  ),
  "plugin-github": covered("plugins/plugin-github/src/routes-e2e.test.ts"),
  "plugin-imessage": covered("plugins/plugin-imessage/src/routes-e2e.test.ts"),
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
      "packages/testing/scenario-runner/test/scenarios/deterministic-app-control-actions.scenario.ts",
    ],
  },
  "plugin-personal-assistant": {
    status: "exempt",
    reason:
      "lifeOps HTTP routes are exercised by the manual live-smoke scenario suite and the plugin-personal-assistant test suite; a keyless route e2e would duplicate that coverage without a deterministic backend.",
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
 * Keep this map empty unless a genuinely untestable plugin lands — never paper
 * a missing test with an exemption.
 */
export const ZERO_TEST_EXEMPT: Record<string, string> = {};
