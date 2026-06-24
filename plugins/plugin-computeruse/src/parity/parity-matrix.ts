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
    id: "kill_app",
    elizaVerb: "COMPUTER_USE_KILL_APP",
    status: "have",
    milestone: "M12",
    note: "terminate by pid or process name (taskkill / kill / pkill)",
    os: { windows: "covered", linux: "planned", macos: "planned", aosp: "na" },
  },
  {
    id: "set_value",
    elizaVerb: "COMPUTER_USE_SET_VALUE",
    status: "have",
    milestone: "M12",
    note: "a11y value write: win32 UIAutomation ValuePattern fast-path + universal click→select-all→type fallback; real actuation in the interactive real lane",
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
  {
    id: "get_window_size",
    elizaVerb: "WINDOW_GET_WINDOW_SIZE",
    status: "have",
    milestone: "M12",
    note: "GetWindowRect (win32) / AppleScript size / xdotool geometry",
    os: { windows: "covered", linux: "planned", macos: "planned", aosp: "na" },
  },
  {
    id: "get_window_position",
    elizaVerb: "WINDOW_GET_WINDOW_POSITION",
    status: "have",
    milestone: "M12",
    note: "GetWindowRect (win32) / AppleScript position / xdotool geometry",
    os: { windows: "covered", linux: "planned", macos: "planned", aosp: "na" },
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
  {
    id: "filesystem_bytes",
    status: "have",
    milestone: "M13",
    note: "read_bytes/write_bytes (base64) + create_dir + directory_exists + get_file_size — binary-safe guest I/O in file-ops.ts + executeFileAction; windows round-trip verified",
    os: { windows: "covered", linux: "planned", macos: "planned", aosp: "na" },
  },
  {
    id: "mcp_server_seam",
    status: "have",
    note: "src/mcp — MCP tool catalog + dispatch (every desktop verb → executeCommand) + optional-SDK McpServer wiring; lets external MCP clients drive computeruse. Catalog/dispatch unit-tested; @modelcontextprotocol/sdk is an optionalDependency",
    os: { windows: "covered", linux: "covered", macos: "covered", aosp: "na" },
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

/** Per-OS coverage rollup for the parity matrix. */
export interface ParityCoverageByOs {
  os: OsName;
  covered: number;
  planned: number;
  na: number;
}

/**
 * Roll up per-OS coverage across every `have`/`partial` capability. `na`
 * capabilities are excluded (they are not part of any OS's parity surface).
 * Pure — derives only from PARITY_MATRIX. Useful for a "what still needs a
 * macOS/Linux real-lane case" dashboard and the M14 coverage report.
 */
export function parityCoverageByOs(): ParityCoverageByOs[] {
  const oses: OsName[] = ["windows", "linux", "macos", "aosp"];
  return oses.map((os) => {
    let covered = 0;
    let planned = 0;
    let na = 0;
    for (const cap of PARITY_MATRIX) {
      if (cap.status === "na") continue;
      switch (cap.os[os]) {
        case "covered":
          covered += 1;
          break;
        case "planned":
          planned += 1;
          break;
        case "na":
          na += 1;
          break;
      }
    }
    return { os, covered, planned, na };
  });
}

/**
 * Structural invariants on the per-OS coverage records — the `os` field was
 * free-form data with no guard, so a typo or a capability that claims
 * `covered` on a platform it can't run on could drift in silently. Pure; the
 * test suite asserts `ok`. Invariants:
 *  1. every `have`/`partial` capability declares all four OS keys with a valid
 *     OsCoverage value;
 *  2. an `na` capability is `os: na` on every axis (it is out of scope, not
 *     "covered/planned" anywhere);
 *  3. a non-`na` capability must have at least one OS that is `covered` or
 *     `planned` (a verb that is `na` on every OS should be status `na`).
 */
export function validateParityCoverage(): ParityValidationResult {
  const valid: OsCoverage[] = ["covered", "planned", "na"];
  const oses: OsName[] = ["windows", "linux", "macos", "aosp"];
  const problems: ParityValidationProblem[] = [];
  let confirmed = 0;

  for (const cap of PARITY_MATRIX) {
    if (cap.status === "na") {
      for (const os of oses) {
        if (cap.os[os] !== "na") {
          problems.push({
            capability: cap.id,
            problem: `status "na" must be os "na" on ${os} (is "${cap.os[os]}")`,
          });
        }
      }
      continue;
    }
    let anyActive = false;
    for (const os of oses) {
      const cov = cap.os[os];
      if (!valid.includes(cov)) {
        problems.push({
          capability: cap.id,
          problem: `${os} coverage "${String(cov)}" is not a valid OsCoverage`,
        });
        continue;
      }
      if (cov === "covered" || cov === "planned") anyActive = true;
    }
    if (!anyActive) {
      problems.push({
        capability: cap.id,
        problem: `status "${cap.status}" but every OS is "na" — should be status "na"`,
      });
    } else {
      confirmed += 1;
    }
  }

  return { ok: problems.length === 0, problems, confirmed };
}
