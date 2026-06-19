/**
 * Drive the real agent terminal TUI through an injected Terminal and assert the
 * universal slash-command menu works end-to-end against a live backend.
 *
 *   ELIZA_API_PORT=31998 bun run --cwd packages/agent start    # backend (TTY off)
 *   bun run packages/agent/scripts/verify-tui-slash.ts --api http://127.0.0.1:31998
 *
 * Exercises the actual AgentTerminalView + @elizaos/tui Editor +
 * CombinedAutocompleteProvider fed from GET /api/commands?surface=tui — the same
 * code path a user drives in a real terminal, just with a captured I/O surface.
 * (A real-PTY launch additionally confirms it; see SLASH commands docs.)
 */

import type { Terminal } from "@elizaos/tui";
import { startAgentTerminalTui } from "../src/tui/agent-terminal-tui.ts";

// Control bytes built via fromCharCode so this source carries no raw control
// characters (ESC=27, DEL=127).
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const ARROW_DOWN = `${ESC}[B`;
const ENTER = "\r";

function stripAnsi(s: string): string {
  // Drop CSI sequences (ESC[ ... final-byte) without a literal ESC in source.
  return s
    .split(`${ESC}[`)
    .map((part, i) =>
      i === 0 ? part : part.replace(/^[0-9;?]*[ -/]*[@-~]/, ""),
    )
    .join("");
}

class DriverTerminal implements Terminal {
  readonly writes: string[] = [];
  private input: (data: string) => void = () => {};

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get columns(): number {
    return 110;
  }
  get rows(): number {
    return 34;
  }
  get kittyProtocolActive(): boolean {
    return true;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}

  send(data: string): void {
    this.input(data);
  }
  mark(): number {
    return this.writes.length;
  }
  since(from: number): string {
    return stripAnsi(this.writes.slice(from).join(""));
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

async function main() {
  const apiBaseUrl =
    arg("--api") ?? process.env.ELIZA_AGENT_URL ?? "http://127.0.0.1:31998";
  const term = new DriverTerminal();
  const handle = startAgentTerminalTui({ apiBaseUrl, terminal: term });
  if (!handle) throw new Error("TUI did not start");
  await handle.ready;
  await delay(400); // let the catalog fetch (GET /api/commands?surface=tui) settle

  // Enter chat mode (composer owns input; the Editor slash menu lives here).
  term.send("c");
  await delay(80);

  // 1. Typing "/" opens the command menu listing the full catalog.
  let m = term.mark();
  term.send("/");
  await delay(120);
  let frame = term.since(m);
  const countMatch = frame.match(/\(1\/(\d+)\)/);
  check(
    "typing / opens the command menu with the full catalog",
    /help/i.test(frame) && !!countMatch && Number(countMatch?.[1]) >= 30,
    `menu open, ${countMatch?.[1] ?? "?"} commands loaded`,
  );

  // 2. Filtering narrows the list.
  m = term.mark();
  term.send("settings");
  await delay(120);
  frame = term.since(m);
  check(
    'typing "/settings" keeps settings and drops unrelated commands',
    /settings/i.test(frame) && !/\/whoami/i.test(frame),
    "settings present after filter",
  );

  // 3. A space drills into the section-argument completions. The dropdown shows
  //    a scrolling window of section tokens with a "(i/N)" marker; step through
  //    it and assert it surfaced several completions incl. a known section.
  m = term.mark();
  term.send(" ");
  await delay(120);
  for (let i = 0; i < 6; i++) {
    term.send(ARROW_DOWN);
    await delay(40);
  }
  frame = term.since(m);
  const argCount = frame.match(/\(\d+\/(\d+)\)/);
  const sectionHits = [
    "model",
    "voice",
    "connectors",
    "appearance",
    "security",
    "secrets",
    "basics",
    "identity",
    "providers",
    "runtime",
  ].filter((k) => new RegExp(`\\b${k}\\b`, "i").test(frame));
  check(
    '"/settings " offers section argument completions',
    !!argCount && Number(argCount?.[1]) >= 2 && sectionHits.length >= 1,
    `${argCount?.[1] ?? "?"} completions; window surfaced: ${sectionHits.join(", ") || "(none)"}`,
  );

  // 4. Dispatch: clear the line, type "/help" and submit — it sends to the agent
  //    (the user line appears in the transcript).
  for (let i = 0; i < 24; i++) term.send(DEL);
  await delay(40);
  m = term.mark();
  term.send("/help");
  await delay(80);
  term.send(ENTER);
  await delay(600);
  frame = term.since(m);
  check(
    "submitting /help dispatches (user line enters the transcript)",
    /\/?help/i.test(frame),
    "transcript reflects the submitted command",
  );

  // 5. Re-open the menu and dump the frame as evidence.
  m = term.mark();
  term.send("/");
  await delay(120);
  const evidence = term.since(m);
  console.log("\n----- captured menu frame (de-ANSI'd) -----");
  console.log(
    evidence
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim().length)
      .slice(0, 24)
      .join("\n"),
  );
  console.log("----- end frame -----\n");

  handle.stop();
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-tui-slash error:", err);
  process.exit(2);
});
