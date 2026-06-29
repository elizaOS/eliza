// Whole-app TUI e2e harness (issue #9969).
//
// Boots the REAL agent terminal shell (`startAgentTerminalTui`) against a real
// `@xterm/headless`-backed terminal emulator (`VirtualTerminal`) and exposes
// `drive()` / `snapshot()` helpers plus `.cast` + viewport/scrollback capture.
// This replaces the bespoke `TestTerminal` whose `text()` regex-stripped ANSI
// instead of emulating a terminal — so assertions now run against the real
// rendered grid (cells, cursor, inverse-video focus), not a flattened string.
//
// `VirtualTerminal` is the canonical headless emulator that already powers
// packages/tui's own render tests; importing it here (rather than re-vendoring)
// keeps one emulator, per the repo's de-duplication mandate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Terminal } from "@elizaos/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
  type AgentTerminalTuiHandle,
  startAgentTerminalTui,
} from "../src/tui/agent-terminal-tui.ts";
import { buildAsciicast, type CastFrame } from "./tui-cast.ts";

/** Control bytes the shell routes (see agent-terminal-tui `handleInput`). */
export const KEY = {
  CTRL_L: String.fromCharCode(12),
  CTRL_C: String.fromCharCode(3),
  ESC: String.fromCharCode(27),
  ENTER: "\r",
} as const;

/**
 * A VirtualTerminal that tees the raw ANSI write stream into a frame log so a
 * run can be exported as an asciicast `.cast` recording. Rendering is still the
 * real xterm emulation — the recording is a side-channel, not a substitute.
 */
export class RecordingTerminal extends VirtualTerminal {
  readonly frames: CastFrame[] = [];
  private readonly startedAt = Date.now();

  override write(data: string): void {
    this.frames.push({ t: (Date.now() - this.startedAt) / 1000, data });
    super.write(data);
  }
}

export interface ShellHandle {
  term: RecordingTerminal;
  handle: AgentTerminalTuiHandle | null;
}

export interface BootOptions {
  fetchImpl: typeof fetch;
  cols?: number;
  rows?: number;
  apiBaseUrl?: string;
}

/** Boot the real agent shell against a recording terminal. */
export function bootShell({
  fetchImpl,
  cols = 80,
  rows = 24,
  apiBaseUrl = "http://127.0.0.1:2138",
}: BootOptions): ShellHandle {
  const term = new RecordingTerminal(cols, rows);
  const handle = startAgentTerminalTui({
    apiBaseUrl,
    terminal: term,
    fetchImpl,
  });
  return { term, handle };
}

/** Drain a few macrotasks so chained awaited fetches settle before assertions. */
export async function flushTicks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Type a sequence of key chunks into the shell, settling render + fetch between each. */
export async function drive(
  term: RecordingTerminal,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    term.sendInput(key);
    await flushTicks();
    await term.flush();
  }
}

export interface Snapshot {
  /** Visible rows, trailing-trimmed. */
  viewport: string[];
  cursor: { x: number; y: number };
  /** Rows that contain inverse-video (focus) cells, as `row: <mask>`. */
  focusRows: string[];
}

/** Deterministic, diffable snapshot of the rendered grid. */
export function snapshot(term: RecordingTerminal): Snapshot {
  const viewport = term.getViewport().map((line) => line.replace(/\s+$/, ""));
  const focusRows: string[] = [];
  for (let row = 0; row < term.rows; row++) {
    let mask = "";
    for (let col = 0; col < term.columns; col++) {
      mask += term.getCellAttributes(row, col)?.isInverse ? "#" : " ";
    }
    const trimmed = mask.replace(/\s+$/, "");
    if (trimmed.length > 0) focusRows.push(`${row}: ${trimmed}`);
  }
  return { viewport, cursor: term.getCursorPosition(), focusRows };
}

/** True if any cell in the visible grid is inverse-video (a focused control). */
export function hasInverseFocus(term: RecordingTerminal): boolean {
  for (let row = 0; row < term.rows; row++) {
    for (let col = 0; col < term.columns; col++) {
      if (term.getCellAttributes(row, col)?.isInverse) return true;
    }
  }
  return false;
}

function artifactDir(): string {
  if (process.env.TUI_E2E_ARTIFACT_DIR) return process.env.TUI_E2E_ARTIFACT_DIR;
  // tui-harness.ts -> test -> agent -> packages -> repo root
  const root = path.resolve(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "..",
    "..",
  );
  return path.join(root, "e2e-recordings", "agent-tui");
}

export interface CapturedArtifacts {
  cast: string;
  viewport: string;
  scrollback: string;
}

/**
 * Write the screen-recording (`.cast`) + screen-capture (viewport) + output
 * capture (scrollback) for a surface. Returns the written paths so a failing
 * test can attach them. Defaults to the gitignored `e2e-recordings/agent-tui/`;
 * point `TUI_E2E_ARTIFACT_DIR` at `.github/issue-evidence/` to commit proof.
 */
export function writeArtifacts(
  name: string,
  term: RecordingTerminal,
): CapturedArtifacts {
  const dir = artifactDir();
  fs.mkdirSync(dir, { recursive: true });
  const cast = path.join(dir, `${name}.cast`);
  fs.writeFileSync(
    cast,
    buildAsciicast(term.frames, {
      width: term.columns,
      height: term.rows,
      title: name,
    }),
  );
  const viewport = path.join(dir, `${name}.viewport.txt`);
  fs.writeFileSync(viewport, `${term.getViewport().join("\n")}\n`);
  const scrollback = path.join(dir, `${name}.scrollback.txt`);
  fs.writeFileSync(scrollback, `${term.getScrollBuffer().join("\n")}\n`);
  return { cast, viewport, scrollback };
}

/** JSON 200 response helper (mirrors the agent backend shape). */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Poll until a request matching `predicate` was issued (deterministic wait). */
export async function waitForCall(
  calls: Array<{ url: string }>,
  predicate: (call: { url: string }) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (calls.some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return calls.some(predicate);
}

export type { Terminal };
