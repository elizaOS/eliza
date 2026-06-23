/**
 * Machine-checkable trycua/cua parity matrix (#9170 M14).
 *
 * The tracking issue maps every cua computer-use capability to its elizaOS
 * status. That map is only trustworthy if it can't silently drift from the
 * code, so this module encodes it as DATA plus a validator: every capability
 * marked `have` with a promoted action verb must actually be registered on the
 * plugin. `validateParityMatrix(actionNames)` is wired into the test suite, so
 * adding a verb to the matrix without registering it (or vice-versa) fails CI.
 *
 * Per-OS coverage records where each capability is exercised (scenario-runner
 * cases + the gated real-driver lanes). `covered` = has evidence today,
 * `planned` = on the M14 backlog, `na` = intentionally out of scope for that OS.
 */

export type ParityStatus = "have" | "partial" | "na";
export type OsName = "windows" | "linux" | "macos" | "aosp";
export type OsCoverage = "covered" | "planned" | "na";

export interface ParityCapability {
  /** cua capability / verb id. */
  id: string;
  /** Promoted elizaOS action verb (when `have`/`partial`), else omitted. */
  elizaVerb?: string;
  status: ParityStatus;
  /** Milestone that delivered it (M7–M13), for traceability. */
  milestone?: string;
  os: Record<OsName, OsCoverage>;
  note?: string;
}

const ALL_PLANNED: Record<OsName, OsCoverage> = {
  windows: "planned",
  linux: "planned",
  macos: "planned",
  aosp: "planned",
};

const DESKTOP_COVERED_AOSP_NA: Record<OsName, OsCoverage> = {
  windows: "covered",
  linux: "covered",
  macos: "covered",
  aosp: "na",
};

/** The canonical capability → status map. */
export const PARITY_MATRIX: readonly ParityCapability[] = [
  // ── High-frequency interaction (pre-M7 parity) ──────────────────────────
  {
    id: "screenshot",
    elizaVerb: "COMPUTER_USE_SCREENSHOT",
    status: "have",
    os: { ...DESKTOP_COVERED_AOSP_NA, aosp: "covered" },
  },
  {
    id: "left_click",
    elizaVerb: "COMPUTER_USE_CLICK",
    status: "have",
    os: { ...DESKTOP_COVERED_AOSP_NA, aosp: "covered" },
  },
  {
    id: "right_click",
    elizaVerb: "COMPUTER_USE_RIGHT_CLICK",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "double_click",
    elizaVerb: "COMPUTER_USE_DOUBLE_CLICK",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "move_cursor",
    elizaVerb: "COMPUTER_USE_MOUSE_MOVE",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "type_text",
    elizaVerb: "COMPUTER_USE_TYPE",
    status: "have",
    os: { ...DESKTOP_COVERED_AOSP_NA, aosp: "covered" },
  },
  {
    id: "press_key",
    elizaVerb: "COMPUTER_USE_KEY",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "hotkey",
    elizaVerb: "COMPUTER_USE_KEY_COMBO",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "scroll",
    elizaVerb: "COMPUTER_USE_SCROLL",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "drag_to",
    elizaVerb: "COMPUTER_USE_DRAG",
    status: "have",
    os: DESKTOP_COVERED_AOSP_NA,
  },
  {
    id: "get_cursor_position",
    elizaVerb: "COMPUTER_USE_GET_CURSOR_POSITION",
    status: "have",
    milestone: "#9165",
    os: { windows: "covered", linux: "planned", macos: "planned", aosp: "na" },
  },
  {
    id: "clipboard",
    elizaVerb: "CLIPBOARD_READ",
    status: "have",
    milestone: "#9165",
    os: { windows: "covered", linux: "planned", macos: "planned", aosp: "na" },
  },

  // ── M7: detect_elements + ocr ────────────────────────────────────────────
  {
    id: "detect_elements",
    elizaVerb: "COMPUTER_USE_DETECT_ELEMENTS",
    status: "have",
    milestone: "M7",
    os: { ...ALL_PLANNED, windows: "covered" },
  },
  {
    id: "ocr",
    elizaVerb: "COMPUTER_USE_OCR",
    status: "have",
    milestone: "M7",
    os: { ...ALL_PLANNED, windows: "covered" },
  },

  // ── M8: granular press/hold + multi-point drag ───────────────────────────
  {
    id: "middle_click",
    elizaVerb: "COMPUTER_USE_MIDDLE_CLICK",
    status: "have",
    milestone: "M8",
    os: { ...ALL_PLANNED, windows: "covered" },
  },
  {
    id: "mouse_down",
    elizaVerb: "COMPUTER_USE_MOUSE_DOWN",
    status: "have",
    milestone: "M8",
    os: { ...ALL_PLANNED, windows: "covered" },
  },
  {
    id: "mouse_up",
    elizaVerb: "COMPUTER_USE_MOUSE_UP",
    status: "have",
    milestone: "M8",
    os: { ...ALL_PLANNED, windows: "covered" },
  },
  {
    id: "key_down",
    elizaVerb: "COMPUTER_USE_KEY_DOWN",
    status: "have",
    milestone: "M8",
    os: { ...ALL_PLANNED, windows: "covered" },
  },
  {
    id: "key_up",
    elizaVerb: "COMPUTER_USE_KEY_UP",
    status: "have",
    milestone: "M8",
    os: { ...ALL_PLANNED, windows: "covered" },
  },
  {
    id: "drag_path",
    elizaVerb: "COMPUTER_USE_DRAG",
    status: "have",
    milestone: "M8",
    note: "multi-point drag via the `path` param",
    os: { ...ALL_PLANNED, windows: "covered" },
  },

  // ── M9: Set-of-Marks grounding ───────────────────────────────────────────
  {
    id: "set_of_marks",
    elizaVerb: "COMPUTER_USE_DETECT_ELEMENTS",
    status: "have",
    milestone: "M9",
    note: "GGUF YOLO + OCR fused into 1-indexed numbered marks + overlay",
    os: ALL_PLANNED,
  },

  // ── M12: window getters + open/launch ────────────────────────────────────
  {
    id: "open",
    elizaVerb: "COMPUTER_USE_OPEN",
    status: "have",
    milestone: "M12",
    os: ALL_PLANNED,
  },
  {
    id: "launch",
    elizaVerb: "COMPUTER_USE_LAUNCH",
    status: "have",
    milestone: "M12",
    os: ALL_PLANNED,
  },
  {
    id: "get_current_window_id",
    elizaVerb: "WINDOW_GET_CURRENT_WINDOW_ID",
    status: "have",
    milestone: "M12",
    os: DESKTOP_COVERED_AOSP_NA_PLANNED(),
  },
  {
    id: "get_application_windows",
    elizaVerb: "WINDOW_GET_APPLICATION_WINDOWS",
    status: "have",
    milestone: "M12",
    os: DESKTOP_COVERED_AOSP_NA_PLANNED(),
  },
  {
    id: "set_window_bounds",
    elizaVerb: "WINDOW_SET_BOUNDS",
    status: "have",
    milestone: "M12",
    os: DESKTOP_COVERED_AOSP_NA_PLANNED(),
  },

  // ── M13: provider matrix (sandbox-only / RPC) ────────────────────────────
  {
    id: "run_command",
    status: "have",
    milestone: "M13",
    note: "sandbox/remote-guest only (host routes through the SHELL action)",
    os: ALL_PLANNED,
  },
  {
    id: "filesystem",
    status: "have",
    milestone: "M13",
    note: "sandbox/remote-guest only (host routes through the FILE action)",
    os: ALL_PLANNED,
  },

  // ── Explicitly N/A (don't chase) ─────────────────────────────────────────
  {
    id: "browser_execute",
    status: "na",
    note: "disabled by policy (GHSA-rcvr-766c-4phv)",
    os: { windows: "na", linux: "na", macos: "na", aosp: "na" },
  },
  {
    id: "set_wallpaper",
    status: "na",
    note: "out of scope",
    os: { windows: "na", linux: "na", macos: "na", aosp: "na" },
  },
  {
    id: "pii_anonymization",
    status: "na",
    note: "out of scope",
    os: { windows: "na", linux: "na", macos: "na", aosp: "na" },
  },
];

function DESKTOP_COVERED_AOSP_NA_PLANNED(): Record<OsName, OsCoverage> {
  return { windows: "planned", linux: "planned", macos: "planned", aosp: "na" };
}

export interface ParityValidationProblem {
  capability: string;
  problem: string;
}

export interface ParityValidationResult {
  ok: boolean;
  problems: ParityValidationProblem[];
  /** Count of `have` capabilities whose verb was confirmed registered. */
  confirmed: number;
}

/** Verbs that are real actions but not promoted from an umbrella (skip check). */
const NON_PROMOTED_PREFIXES = ["COMPUTER_USE_", "WINDOW_", "CLIPBOARD_"];

/**
 * Cross-check the matrix against the live action surface. Every `have`/`partial`
 * capability whose `elizaVerb` is a promoted action (COMPUTER_USE_* / WINDOW_* /
 * CLIPBOARD_*) must appear in `actionNames`. Pure — the caller passes the
 * plugin's registered action names.
 */
export function validateParityMatrix(
  actionNames: readonly string[],
): ParityValidationResult {
  const registered = new Set(actionNames);
  const problems: ParityValidationProblem[] = [];
  let confirmed = 0;

  for (const cap of PARITY_MATRIX) {
    if (cap.status === "na") {
      if (cap.elizaVerb) {
        problems.push({
          capability: cap.id,
          problem: `status "na" must not declare an elizaVerb (${cap.elizaVerb})`,
        });
      }
      continue;
    }
    if (!cap.elizaVerb) continue; // partial/have without a single promoted verb (e.g. run_command)
    const isPromoted = NON_PROMOTED_PREFIXES.some((p) =>
      cap.elizaVerb?.startsWith(p),
    );
    if (!isPromoted) continue;
    if (!registered.has(cap.elizaVerb)) {
      problems.push({
        capability: cap.id,
        problem: `verb ${cap.elizaVerb} is marked "${cap.status}" but is NOT a registered action`,
      });
    } else {
      confirmed += 1;
    }
  }

  return { ok: problems.length === 0, problems, confirmed };
}

/** Summary counts for reporting / dashboards. */
export function parityMatrixSummary(): {
  have: number;
  partial: number;
  na: number;
  total: number;
} {
  let have = 0;
  let partial = 0;
  let na = 0;
  for (const cap of PARITY_MATRIX) {
    if (cap.status === "have") have += 1;
    else if (cap.status === "partial") partial += 1;
    else na += 1;
  }
  return { have, partial, na, total: PARITY_MATRIX.length };
}
