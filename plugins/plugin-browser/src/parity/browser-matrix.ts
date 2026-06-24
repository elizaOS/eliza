/**
 * Machine-checkable CUA ⇄ browser parity matrix (#9476).
 *
 * `plugin-computeruse` ships a parity matrix (`src/parity/parity-matrix.ts`)
 * that maps every computer-use capability to a registered action verb and a
 * per-OS coverage record, validated against the live action surface so it can't
 * silently drift. `plugin-browser` had no equivalent: browser automation is a
 * real shipping surface but its capability set, its test depth, and its
 * benchmark coverage were undocumented and unenforced.
 *
 * This module is the browser-side analog. It encodes, as DATA plus validators:
 *   1. every browser capability → its promoted `BROWSER_*` action verb, and
 *   2. the CUA-vs-browser coverage delta (the parity GAP) — what is tested with
 *      a real engine, what only with mocks, and what is benchmarked *through*
 *      `plugin-browser` (vs. the inference layer that bypasses it).
 *
 * The companion test (`browser-matrix.test.ts`) cross-checks the matrix against
 * the live registered surface in BOTH directions — every `have` verb must be a
 * registered action, and every registered `BROWSER_*` action must appear in the
 * matrix — and ratchets the coverage baseline against the filesystem so closing
 * a gap (e.g. adding a real-engine test lane) fails the test until the matrix is
 * updated to record the win.
 */

export type BrowserParityStatus = "have" | "partial" | "na";

/** Depth at which a browser capability is exercised by automated tests today. */
export type BrowserTestDepth = "real" | "mock" | "none";

export interface BrowserParityCapability {
  /** Browser capability id (mirrors the CUA capability id where one exists). */
  id: string;
  /**
   * Promoted `BROWSER_*` action verb (present for `have`/`partial`, omitted for
   * `na`). These are the names `promoteSubactionsToActions(browserAction)`
   * registers — the planner-visible surface.
   */
  verb?: string;
  status: BrowserParityStatus;
  /** Test depth on the browser side today (see #9476 — all are `mock`). */
  tested: BrowserTestDepth;
  /** Whether a benchmark exercises this capability THROUGH plugin-browser. */
  benchmarked: boolean;
  /** The CUA capability this corresponds to, for cross-surface parity. */
  cuaCounterpart?: string;
  note?: string;
}

/**
 * The canonical capability → verb map. Verbs are the promoted action names
 * `BROWSER_<UPPER_SNAKE(subaction)>` derived from the `action` enum on
 * `browserAction` (`src/actions/browser.ts`). `tested`/`benchmarked` encode the
 * #9476 parity gap: browser automation is tested mock/JSDOM-only with zero
 * real-engine lanes and zero benchmarks wired through the plugin.
 */
export const BROWSER_PARITY_MATRIX: readonly BrowserParityCapability[] = [
  // ── Navigation ──────────────────────────────────────────────────────────
  {
    id: "navigate",
    verb: "BROWSER_NAVIGATE",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "open",
  },
  {
    id: "open",
    verb: "BROWSER_OPEN",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "back",
    verb: "BROWSER_BACK",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "forward",
    verb: "BROWSER_FORWARD",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "reload",
    verb: "BROWSER_RELOAD",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "wait",
    verb: "BROWSER_WAIT",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "wait_for_url",
    verb: "BROWSER_WAIT_FOR_URL",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  // ── Interaction ─────────────────────────────────────────────────────────
  {
    id: "click",
    verb: "BROWSER_CLICK",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "left_click",
  },
  {
    id: "type",
    verb: "BROWSER_TYPE",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "type_text",
  },
  {
    id: "press",
    verb: "BROWSER_PRESS",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "key_press",
  },
  // ── Perception ──────────────────────────────────────────────────────────
  {
    id: "screenshot",
    verb: "BROWSER_SCREENSHOT",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "screenshot",
    note: "Captured but never validated against a real engine (no real lane).",
  },
  {
    id: "snapshot",
    verb: "BROWSER_SNAPSHOT",
    status: "have",
    tested: "mock",
    benchmarked: false,
    note: "Accessibility/DOM tree snapshot — the browser analog of CUA Set-of-Marks.",
  },
  {
    id: "get",
    verb: "BROWSER_GET",
    status: "have",
    tested: "mock",
    benchmarked: false,
    note: "DOM/attribute extraction.",
  },
  {
    id: "state",
    verb: "BROWSER_STATE",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "info",
    verb: "BROWSER_INFO",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  // ── Window / surface ────────────────────────────────────────────────────
  {
    id: "show",
    verb: "BROWSER_SHOW",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "hide",
    verb: "BROWSER_HIDE",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "close",
    verb: "BROWSER_CLOSE",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  // ── Tabs ────────────────────────────────────────────────────────────────
  {
    id: "tab",
    verb: "BROWSER_TAB",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "open_tab",
    verb: "BROWSER_OPEN_TAB",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "close_tab",
    verb: "BROWSER_CLOSE_TAB",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "switch_tab",
    verb: "BROWSER_SWITCH_TAB",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "list_tabs",
    verb: "BROWSER_LIST_TABS",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  // ── Context ─────────────────────────────────────────────────────────────
  {
    id: "context",
    verb: "BROWSER_CONTEXT",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "get_context",
    verb: "BROWSER_GET_CONTEXT",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  // ── Watch-mode (visible cursor + faithful pointer/keyboard events) ──────
  {
    id: "realistic_click",
    verb: "BROWSER_REALISTIC_CLICK",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "left_click",
    note: "Watch-mode: animated cursor + real pointer events. Desktop backend only.",
  },
  {
    id: "realistic_fill",
    verb: "BROWSER_REALISTIC_FILL",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "realistic_type",
    verb: "BROWSER_REALISTIC_TYPE",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "type_text",
  },
  {
    id: "realistic_press",
    verb: "BROWSER_REALISTIC_PRESS",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  {
    id: "cursor_move",
    verb: "BROWSER_CURSOR_MOVE",
    status: "have",
    tested: "mock",
    benchmarked: false,
    cuaCounterpart: "move_cursor",
  },
  {
    id: "cursor_hide",
    verb: "BROWSER_CURSOR_HIDE",
    status: "have",
    tested: "mock",
    benchmarked: false,
  },
  // ── Auth ────────────────────────────────────────────────────────────────
  {
    id: "autofill_login",
    verb: "BROWSER_AUTOFILL_LOGIN",
    status: "have",
    tested: "mock",
    benchmarked: false,
    note: "Saved-credential autofill; no real-engine lane exercises it.",
  },
  // ── Cross-surface parity gaps (CUA has these; browser does not) ──────────
  {
    id: "visual_grounding",
    status: "na",
    tested: "none",
    benchmarked: false,
    cuaCounterpart: "detect_elements",
    note: "CUA grounds clicks visually (OCR / Set-of-Marks / ScreenSpot point-in-bbox). Browser targets DOM selectors; there is no web-element visual grounding benchmark wired through plugin-browser.",
  },
  {
    id: "scene_vision",
    status: "na",
    tested: "none",
    benchmarked: false,
    cuaCounterpart: "scene_builder",
    note: "CUA builds a scene model (Brain). Browser reasons over the DOM tree, not a rendered-pixel scene model.",
  },
  {
    id: "frame_dedup",
    status: "na",
    tested: "none",
    benchmarked: false,
    cuaCounterpart: "dhash_dedup",
    note: "CUA dHash-dedups consecutive frames to skip redundant vision calls. Browser re-captures every turn; no DOM/screenshot dedup seam exists.",
  },
];

export interface BrowserParityProblem {
  capability: string;
  problem: string;
}

export interface BrowserParityValidationResult {
  ok: boolean;
  problems: BrowserParityProblem[];
  /** Count of `have`/`partial` verbs confirmed against the live surface. */
  confirmed: number;
}

/**
 * Cross-check the matrix against the live registered action surface, BOTH ways:
 *   - every `have`/`partial` capability must declare a verb that is registered;
 *   - every `na` capability must NOT declare a verb;
 *   - every registered `BROWSER_*` verb must appear in the matrix (so a new
 *     subaction can't be promoted without recording its parity status).
 *
 * Pure — the caller passes the plugin's registered action names. Adding a
 * subaction without a matrix entry (or a matrix verb without registering it)
 * fails CI.
 */
export function validateBrowserMatrix(
  actionNames: readonly string[],
): BrowserParityValidationResult {
  const registered = new Set(actionNames);
  const problems: BrowserParityProblem[] = [];
  let confirmed = 0;

  const matrixVerbs = new Set<string>();
  for (const cap of BROWSER_PARITY_MATRIX) {
    if (cap.status === "na") {
      if (cap.verb) {
        problems.push({
          capability: cap.id,
          problem: `status "na" must not declare a verb (${cap.verb})`,
        });
      }
      continue;
    }
    if (!cap.verb) {
      problems.push({
        capability: cap.id,
        problem: `status "${cap.status}" must declare a verb`,
      });
      continue;
    }
    matrixVerbs.add(cap.verb);
    if (!registered.has(cap.verb)) {
      problems.push({
        capability: cap.id,
        problem: `verb ${cap.verb} is marked "${cap.status}" but is NOT a registered action`,
      });
    } else {
      confirmed += 1;
    }
  }

  // Reverse direction: every registered BROWSER_* verb must be documented.
  for (const name of registered) {
    if (name === "BROWSER") continue; // the umbrella parent action
    if (!name.startsWith("BROWSER_")) continue;
    if (!matrixVerbs.has(name)) {
      problems.push({
        capability: name,
        problem: `registered action ${name} has no parity-matrix entry`,
      });
    }
  }

  return { ok: problems.length === 0, problems, confirmed };
}

export interface BrowserParitySummary {
  have: number;
  partial: number;
  na: number;
  total: number;
  /** Capabilities exercised by a real-engine test today. */
  realTested: number;
  /** Capabilities exercised only by mocks/JSDOM. */
  mockTested: number;
  /** Capabilities with no automated test. */
  untested: number;
  /** Capabilities benchmarked through plugin-browser. */
  benchmarked: number;
}

export function browserParitySummary(): BrowserParitySummary {
  let have = 0;
  let partial = 0;
  let na = 0;
  let realTested = 0;
  let mockTested = 0;
  let untested = 0;
  let benchmarked = 0;
  for (const cap of BROWSER_PARITY_MATRIX) {
    if (cap.status === "have") have += 1;
    else if (cap.status === "partial") partial += 1;
    else na += 1;
    if (cap.tested === "real") realTested += 1;
    else if (cap.tested === "mock") mockTested += 1;
    else untested += 1;
    if (cap.benchmarked) benchmarked += 1;
  }
  return {
    have,
    partial,
    na,
    total: BROWSER_PARITY_MATRIX.length,
    realTested,
    mockTested,
    untested,
    benchmarked,
  };
}

/**
 * The CUA-vs-browser coverage baseline — the parity GAP as enforceable data.
 * These are the dimensions where `plugin-computeruse` is ahead of
 * `plugin-browser` today (#9476). The companion test ratchets `realTestLanes`
 * against the filesystem: add a real-engine browser test lane and the test
 * fails until this number is bumped, forcing the win to be recorded.
 */
export interface BrowserCoverageBaseline {
  /** `*.real.test.ts` / `*.e2e.test.ts` lanes in plugin-browser (CUA has 13). */
  realTestLanes: number;
  /** Benchmarks wired through plugin-browser actions (CUA has OSWorld). */
  benchmarksThroughPlugin: number;
  /** Machine-checkable capability/parity matrix exists (this module). */
  hasParityMatrix: boolean;
  /** Typed browser error-code contract exists (CUA has screenshot-errors). */
  hasTypedErrorContract: boolean;
}

export const BROWSER_COVERAGE_BASELINE: BrowserCoverageBaseline = {
  realTestLanes: 0,
  benchmarksThroughPlugin: 0,
  hasParityMatrix: true,
  hasTypedErrorContract: false,
};
