/**
 * trycua/cua parity COVERAGE GUARD (#9170, M14).
 *
 * A single machine-checkable registry of every trycua/cua capability, each tagged
 * `have` | `partial` | `missing` | `na`. This is the executable form of
 * `docs/TRYCUA_PARITY_AUDIT.md`: it fails CI when a `have` verb is dropped from the
 * live action surface, when a host input verb loses its test coverage, or when an
 * `na` decision is silently reverted (e.g. browser_execute re-enabled).
 *
 * Crucially this runs in the DEFAULT lane — i.e. on Windows, Linux, macOS and the
 * AOSP/Node test runner alike — so "we have parity, and every verb is tested" is
 * verified on ALL platforms, not just the win32-gated real-driver lane. The real
 * actuation of each verb on a live desktop is the `*.real.test.ts` lane (Windows
 * today; Linux/macOS once their headful CI lanes exist — see audit §3/§5).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import { isBrowserExecuteAllowed } from "../security/browser-script-policy.js";

type Domain =
  | "input" // host pointer/keyboard/screen verb on COMPUTER_USE
  | "vision" // OCR / detect / get_screen (computeruse enum or plugin-vision)
  | "window" // WINDOW action verb
  | "clipboard" // CLIPBOARD action verb
  | "architecture" // loop/provider/RPC/MCP/eval — not a single verb
  | "mobile";

type Status = "have" | "partial" | "missing" | "na";

interface Capability {
  /** trycua/cua capability name. */
  cua: string;
  domain: Domain;
  status: Status;
  /** elizaOS COMPUTER_USE/WINDOW/CLIPBOARD verb that satisfies it, when applicable. */
  verb?: string;
  /** Required when status === "na": why we deliberately don't chase it. */
  na?: string;
  /** Milestone tracking the remaining work, when partial/missing. */
  milestone?: string;
}

// The full surface. Keep in sync with docs/TRYCUA_PARITY_AUDIT.md.
const CAPABILITIES: Capability[] = [
  // ── host input ────────────────────────────────────────────────────────────
  { cua: "screenshot", domain: "input", status: "have", verb: "screenshot" },
  { cua: "left_click", domain: "input", status: "have", verb: "click" },
  { cua: "right_click", domain: "input", status: "have", verb: "right_click" },
  {
    cua: "double_click",
    domain: "input",
    status: "have",
    verb: "double_click",
  },
  {
    cua: "middle_click",
    domain: "input",
    status: "have",
    verb: "middle_click",
  },
  {
    cua: "click_with_modifiers",
    domain: "input",
    status: "have",
    verb: "click_with_modifiers",
  },
  { cua: "move_cursor", domain: "input", status: "have", verb: "mouse_move" },
  {
    cua: "left_mouse_down",
    domain: "input",
    status: "have",
    verb: "mouse_down",
  },
  { cua: "left_mouse_up", domain: "input", status: "have", verb: "mouse_up" },
  { cua: "type_text", domain: "input", status: "have", verb: "type" },
  { cua: "press_key", domain: "input", status: "have", verb: "key" },
  { cua: "hotkey", domain: "input", status: "have", verb: "key_combo" },
  { cua: "key_down", domain: "input", status: "have", verb: "key_down" },
  { cua: "key_up", domain: "input", status: "have", verb: "key_up" },
  { cua: "scroll", domain: "input", status: "have", verb: "scroll" },
  { cua: "drag", domain: "input", status: "have", verb: "drag" },
  {
    cua: "get_cursor_position",
    domain: "input",
    status: "have",
    verb: "get_cursor_position",
  },
  // ── vision ────────────────────────────────────────────────────────────────
  { cua: "ocr", domain: "vision", status: "have", verb: "ocr" },
  {
    cua: "detect_elements",
    domain: "vision",
    status: "have",
    verb: "detect_elements",
  },
  {
    cua: "get_screen (typed image + elements, token-frugal)",
    domain: "vision",
    status: "have", // plugin-vision GET_SCREEN / GET_SCREEN_ELEMENTS (M2)
  },
  {
    cua: "set_of_marks_overlay",
    domain: "vision",
    status: "have", // M9: plugin-vision som.ts + set-of-marks-provider via registerSetOfMarksProvider seam
  },
  // ── window ────────────────────────────────────────────────────────────────
  { cua: "window_list", domain: "window", status: "have", verb: "list" },
  { cua: "activate_window", domain: "window", status: "have", verb: "focus" },
  {
    cua: "minimize_window",
    domain: "window",
    status: "have",
    verb: "minimize",
  },
  {
    cua: "maximize_window",
    domain: "window",
    status: "have",
    verb: "maximize",
  },
  { cua: "restore_window", domain: "window", status: "have", verb: "restore" },
  { cua: "close_window", domain: "window", status: "have", verb: "close" },
  {
    cua: "set_window_position",
    domain: "window",
    status: "have",
    verb: "move",
  },
  // M12 window getters/setters — all landed.
  {
    cua: "get_current_window_id",
    domain: "window",
    status: "have",
    verb: "get_current_window_id",
    milestone: "M12",
  },
  {
    cua: "get_application_windows",
    domain: "window",
    status: "have",
    verb: "get_application_windows",
    milestone: "M12",
  },
  {
    cua: "set_window_size (set_bounds)",
    domain: "window",
    status: "have",
    verb: "set_bounds",
    milestone: "M12",
  },
  {
    cua: "get_window_size",
    domain: "window",
    status: "have",
    verb: "get_window_size",
    milestone: "M12",
  },
  {
    cua: "get_window_position",
    domain: "window",
    status: "have",
    verb: "get_window_position",
    milestone: "M12",
  },
  // open/launch are COMPUTER_USE verbs (implemented; launch returns a pid).
  {
    cua: "open(target)",
    domain: "input",
    status: "have",
    verb: "open",
    milestone: "M12",
  },
  {
    cua: "launch(app,args)->pid",
    domain: "input",
    status: "have",
    verb: "launch",
    milestone: "M12",
  },
  // ── clipboard ───────────────────────────────────────────────────────────────
  {
    cua: "copy_to_clipboard",
    domain: "clipboard",
    status: "have",
    verb: "read",
  },
  { cua: "set_clipboard", domain: "clipboard", status: "have", verb: "write" },
  // ── filesystem / shell (gated/internal today) ───────────────────────────────
  // Host file/shell route through the FILE / SHELL actions; sandbox guests get
  // run_command + basic fs over the M13 RPC. Basic ops exist; the binary/dir
  // transfer verbs below are genuine gaps (cua exposes them for guest I/O).
  {
    cua: "filesystem basic (exists/list/read_text/write_text/delete)",
    domain: "architecture",
    status: "partial",
    milestone: "M13",
  },
  {
    cua: "run_command (CommandResult)",
    domain: "architecture",
    status: "partial",
    milestone: "M13",
  },
  {
    cua: "read_bytes/write_bytes (base64 binary), create_dir, directory_exists, get_file_size",
    domain: "architecture",
    status: "have",
    milestone: "M13 — file-ops binary I/O + executeFileAction",
  },
  // ── trycua blind spots — tracked decisions, not silent gaps (workflow audit) ──
  {
    cua: "set_value (a11y element value write)",
    domain: "input",
    status: "have",
    verb: "set_value",
    milestone: "M12",
  },
  {
    cua: "kill_app (process terminate)",
    domain: "input",
    status: "have",
    verb: "kill_app",
    milestone: "M12",
  },
  {
    cua: "zoom (region magnify for grounding)",
    domain: "architecture",
    status: "partial",
    milestone: "covered by M5 ROI + M9 Set-of-Marks",
  },
  {
    cua: "screen recording / replay_trajectory (MP4)",
    domain: "architecture",
    status: "na",
    na: "evidence concern owned by test:e2e:record + scenario-runner viewer, not an agent verb",
  },
  {
    cua: "agent-cursor overlay (set_agent_cursor_*)",
    domain: "architecture",
    status: "na",
    na: "UX overlay tied to cua's recording; no agent-decision value",
  },
  // ── architecture ────────────────────────────────────────────────────────────
  {
    cua: "agent_loop_registry",
    domain: "architecture",
    status: "partial",
    milestone: "M10",
  },
  {
    cua: "predict_step/predict_click split",
    domain: "architecture",
    status: "partial",
    milestone: "M10",
  },
  {
    cua: "callback_middleware (budget/retention/trajectory)",
    domain: "architecture",
    status: "partial",
    milestone: "M11",
  },
  {
    cua: "vm/sandbox provider matrix",
    domain: "architecture",
    status: "partial",
    milestone: "M13",
  },
  {
    cua: "daemon/RPC seam",
    domain: "architecture",
    status: "missing",
    milestone: "M13",
  },
  {
    cua: "MCP server seam",
    domain: "architecture",
    status: "have",
    milestone: "src/mcp — tool catalog + dispatch + optional-SDK server",
  },
  {
    cua: "eval harness (ScreenSpot/OSWorld/per-OS scenarios)",
    domain: "architecture",
    status: "partial",
    milestone: "M14",
  },
  {
    cua: "low-token continuous screen description",
    domain: "architecture",
    status: "have",
  },
  {
    cua: "accessibility tree grounding",
    domain: "architecture",
    status: "have",
  },
  // ── mobile / AOSP ─────────────────────────────────────────────────────────────
  {
    cua: "android tap/swipe + hardware keys",
    domain: "mobile",
    status: "have",
  },
  { cua: "android multitouch_gesture", domain: "mobile", status: "missing" },
  // ── deliberately not chased ──────────────────────────────────────────────────
  {
    cua: "browser_execute / playwright_exec",
    domain: "architecture",
    status: "na",
    na: "Unconditionally disabled by security policy (GHSA-rcvr-766c-4phv).",
  },
  {
    cua: "set_wallpaper",
    domain: "architecture",
    status: "na",
    na: "Niche; no agent value.",
  },
  {
    cua: "cloud managed sandbox",
    domain: "architecture",
    status: "na",
    na: "We control the local machine in-process; cloud VM fleet out of scope.",
  },
];

const INPUT_VERBS = CAPABILITIES.filter(
  (c) =>
    (c.domain === "input" || (c.domain === "vision" && c.verb)) &&
    c.status === "have" &&
    c.verb,
).map((c) => c.verb as string);

// Live action surface.
const actions = computerUsePlugin.actions ?? [];
const actionNames = actions.map((a) => a.name);
const computerUse = actions.find((a) => a.name === "COMPUTER_USE") as
  | { parameters?: Array<{ name: string; schema?: { enum?: string[] } }> }
  | undefined;
const enumVerbs =
  computerUse?.parameters?.find((p) => p.name === "action")?.schema?.enum ?? [];

// Test corpus (every *.test.ts under __tests__, minus this file).
const testDir = dirname(fileURLToPath(import.meta.url));
const SELF = "cua-parity-coverage.test.ts";
const corpus = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts") && f !== SELF)
  .map((f) => readFileSync(join(testDir, f), "utf8"))
  .join("\n");

describe("cua parity registry integrity", () => {
  it("every capability has a known status; na entries justify themselves", () => {
    for (const c of CAPABILITIES) {
      expect(["have", "partial", "missing", "na"]).toContain(c.status);
      if (c.status === "na") {
        expect(c.na, `na capability "${c.cua}" needs a reason`).toBeTruthy();
      }
    }
  });

  it("has no duplicate verb mappings", () => {
    const verbs = CAPABILITIES.map((c) => c.verb).filter(Boolean) as string[];
    expect(new Set(verbs).size).toBe(verbs.length);
  });
});

describe("cua parity surface (all platforms)", () => {
  it("every have/input + ocr/detect verb is in the COMPUTER_USE action enum", () => {
    for (const v of INPUT_VERBS) {
      expect(enumVerbs, `enum: ${enumVerbs.join(", ")}`).toContain(v);
    }
  });

  it("every have/window verb is a promoted WINDOW action", () => {
    for (const c of CAPABILITIES.filter(
      (c) => c.domain === "window" && c.status === "have" && c.verb,
    )) {
      const promoted = `WINDOW_${(c.verb as string).toUpperCase()}`;
      expect(actionNames, actionNames.join(", ")).toContain(promoted);
    }
  });

  it("clipboard read/write are promoted CLIPBOARD actions", () => {
    expect(actionNames).toContain("CLIPBOARD_READ");
    expect(actionNames).toContain("CLIPBOARD_WRITE");
  });

  it("Set-of-Marks (M9) registry seam exists for plugin-vision to wire", () => {
    // M9 is a grounding capability (no discrete verb): plugin-vision builds the
    // numbered overlay (som.ts) and registers it through this seam. Assert the
    // seam is present so the `have` status above can't silently regress.
    const ocrProviderSrc = readFileSync(
      join(testDir, "..", "mobile", "ocr-provider.ts"),
      "utf8",
    );
    expect(ocrProviderSrc).toContain("registerSetOfMarksProvider");
    expect(ocrProviderSrc).toContain("SetOfMarksProvider");
  });
});

describe("cua parity test-coverage (every input/vision verb is tested)", () => {
  it.each(INPUT_VERBS)("verb %s is referenced by at least one test", (verb) => {
    const upper = `COMPUTER_USE_${verb.toUpperCase()}`;
    const referenced =
      corpus.includes(`"${verb}"`) ||
      corpus.includes(`'${verb}'`) ||
      corpus.includes(upper);
    expect(
      referenced,
      `no test references verb "${verb}" (snake or ${upper})`,
    ).toBe(true);
  });
});

describe("cua parity N/A decisions are honored", () => {
  it("browser_execute stays disabled (GHSA-rcvr-766c-4phv)", () => {
    expect(isBrowserExecuteAllowed()).toBe(false);
  });
});
