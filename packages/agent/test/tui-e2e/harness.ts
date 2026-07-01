/**
 * Whole-app TUI e2e harness.
 *
 * Boots the *real* agent terminal shell (`startAgentTerminalTui`) against a
 * `VirtualTerminal` — the `@xterm/headless`-backed emulator that implements the
 * same `Terminal` interface `ProcessTerminal` does — and reads the rendered grid
 * back cell-accurately. No regex ANSI-stripping, no fake terminal: assertions
 * run against `getViewport()` (screen capture), `getCursorPosition()`, and
 * `getCellAttributes()` (inverse-video focus), exactly what a real terminal
 * shows.
 *
 * Determinism: fixed 80×24 grid, a stubbed `fetchImpl` (no network, no clock in
 * the render path), renders flushed on `process.nextTick`. Frames are byte-stable
 * across machines, so `serializeSnapshot()` output can be committed as a golden
 * fixture and diffed.
 */

import { visibleWidth } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import { startAgentTerminalTui } from "../../src/tui/agent-terminal-tui.ts";

export const KEYS = {
  CTRL_C: "",
  CTRL_L: "",
  ESC: "",
  ENTER: "\r",
  TAB: "\t",
} as const;

/** A recorded outbound request the shell issued through the stubbed fetch. */
export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  init?: RequestInit;
}

/** One stubbed backend route: match a request, return a JSON body. */
export interface StubRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => unknown;
}

export interface StubFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a deterministic `fetchImpl` from a route table. Every request is
 * recorded (url, method, parsed JSON body) so tests can assert the round-trip
 * (TUI key → POST /api/… ) without guessing tick counts. Unmatched routes 404.
 */
export function makeStubFetch(routes: StubRoute[]): StubFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? "GET", body, init });
    const route = routes.find((candidate) => candidate.match(url, init));
    if (route) return jsonResponse(route.respond(url, init));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A common views-list route returning the given `viewType: "tui"` views. */
export function viewsRoute(
  views: Array<{ id: string; label: string; path?: string }>,
): StubRoute {
  return {
    match: (url) => url.endsWith("/api/views?viewType=tui"),
    respond: () => ({
      views: views.map((view) => ({
        ...view,
        path: view.path ?? `/${view.id}/tui`,
        viewType: "tui",
      })),
    }),
  };
}

/** Navigate + activate routes that always succeed, for any view id. */
export const okViewRoutes: StubRoute[] = [
  {
    match: (url) => url.includes("/navigate?viewType=tui"),
    respond: () => ({ ok: true }),
  },
  {
    match: (url) => url.includes("/activate?viewType=tui"),
    respond: (url) => ({ ok: true, url }),
  },
];

/** Conversation create + message-post routes for the chat path. */
export function chatRoutes(conversationId = "conv-terminal"): StubRoute[] {
  return [
    {
      match: (url, init) =>
        url.endsWith("/api/conversations") && init?.method === "POST",
      respond: () => ({ conversation: { id: conversationId } }),
    },
    {
      match: (url) =>
        url.endsWith(`/api/conversations/${conversationId}/messages`),
      respond: () => ({ ok: true }),
    },
  ];
}

export interface BootedShell {
  terminal: VirtualTerminal;
  handle: NonNullable<ReturnType<typeof startAgentTerminalTui>>;
  calls: RecordedCall[];
}

/** Drain queued `process.nextTick` renders + chained awaited fetches. */
export async function settle(passes = 6): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Boot the real shell against a fresh `VirtualTerminal`. Awaits the initial
 * view/command refresh and the first rendered frame.
 */
export async function bootShell(options: {
  routes: StubRoute[];
  apiBaseUrl?: string;
  columns?: number;
  rows?: number;
}): Promise<BootedShell> {
  const { fetchImpl, calls } = makeStubFetch(options.routes);
  const terminal = new VirtualTerminal(
    options.columns ?? 80,
    options.rows ?? 24,
  );
  const handle = startAgentTerminalTui({
    apiBaseUrl: options.apiBaseUrl ?? "http://127.0.0.1:2138",
    terminal,
    fetchImpl,
  });
  if (!handle) throw new Error("agent terminal tui did not start");
  await handle.ready;
  await settle();
  await terminal.flush();
  return { terminal, handle, calls };
}

/** Send a sequence of key chunks to the shell, then drain renders + fetches. */
export async function drive(
  terminal: VirtualTerminal,
  keys: string[],
): Promise<void> {
  for (const key of keys) terminal.sendInput(key);
  await settle();
  await terminal.flush();
}

/** Type a string one character at a time (closer to real keypresses). */
export async function type(
  terminal: VirtualTerminal,
  text: string,
): Promise<void> {
  await drive(terminal, [...text]);
}

/** Right-trimmed viewport lines — the rendered screen, no ANSI. */
export function viewport(terminal: VirtualTerminal): string[] {
  return terminal.getViewport().map((line) => line.replace(/\s+$/u, ""));
}

/** The whole viewport joined — for `.toContain` text assertions. */
export function screenText(terminal: VirtualTerminal): string {
  return viewport(terminal).join("\n");
}

/** Contiguous runs of inverse-video (focused) cells, per row. */
export interface InverseRun {
  row: number;
  colStart: number;
  colEnd: number;
  text: string;
}

export function inverseRuns(terminal: VirtualTerminal): InverseRun[] {
  const runs: InverseRun[] = [];
  const lines = terminal.getViewport();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    let start = -1;
    for (let col = 0; col <= line.length; col++) {
      const attrs =
        col < line.length ? terminal.getCellAttributes(row, col) : null;
      const inverse = attrs ? attrs.isInverse !== 0 : false;
      if (inverse && start === -1) {
        start = col;
      } else if (!inverse && start !== -1) {
        runs.push({
          row,
          colStart: start,
          colEnd: col - 1,
          text: line.slice(start, col).trimEnd(),
        });
        start = -1;
      }
    }
  }
  return runs;
}

/**
 * A deterministic, committable serialization of the rendered frame: the
 * right-trimmed viewport, the cursor cell, and every inverse-video run. Stable
 * for a fixed grid size and stubbed inputs.
 */
export function serializeSnapshot(terminal: VirtualTerminal): string {
  const lines = viewport(terminal);
  const cursor = terminal.getCursorPosition();
  const runs = inverseRuns(terminal);
  const out: string[] = [];
  out.push(`# viewport ${terminal.columns}x${terminal.rows}`);
  for (const line of lines) out.push(`| ${line}`);
  out.push(`# cursor ${cursor.x},${cursor.y}`);
  out.push("# inverse");
  for (const run of runs) {
    out.push(`@ ${run.row}:${run.colStart}-${run.colEnd} ${run.text}`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Assert every rendered line fits the width contract: a TUI component must never
 * return a line wider than the terminal (`visibleWidth(line) <= width`).
 */
export function assertWidthContract(lines: string[], width: number): void {
  for (const line of lines) {
    const w = visibleWidth(line);
    if (w > width) {
      throw new Error(
        `width contract violated: visibleWidth ${w} > ${width} for line ${JSON.stringify(line)}`,
      );
    }
  }
}
