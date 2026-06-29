/**
 * Capture + record artifacts for the TUI e2e lane (satisfies #9944 for the
 * terminal surface).
 *
 * A `VirtualTerminal` records every raw `write()` the differential renderer
 * flushed. From that we produce three artifacts a reviewer can inspect without
 * reading code:
 *
 * - **`.cast`** — an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/)
 *   recording. Each rendered frame becomes a playback event, so the file plays
 *   back the whole session in `asciinema play`. This is the "video walkthrough"
 *   for a terminal surface.
 * - **`.viewport.txt`** — the final visible grid (screen capture).
 * - **`.scrollback.txt`** — the full buffer incl. scrollback (output capture).
 *
 * Frame timing uses a fixed interval (no clock) so the recording is
 * deterministic and replayable across machines.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VirtualTerminal } from "@elizaos/tui/testing";

export interface AsciicastHeader {
  version: 2;
  width: number;
  height: number;
  title?: string;
  env?: Record<string, string>;
}

export type AsciicastEvent = [number, "o", string];

/**
 * Build an asciicast v2 document from a `VirtualTerminal`'s recorded frames.
 * Returns the full `.cast` text (newline-delimited JSON: header + one event per
 * frame). `intervalSec` is the fixed gap between frames (deterministic, no clock).
 */
export function toAsciicast(
  terminal: VirtualTerminal,
  options: { title?: string; intervalSec?: number } = {},
): string {
  const interval = options.intervalSec ?? 0.05;
  const header: AsciicastHeader = {
    version: 2,
    width: terminal.columns,
    height: terminal.rows,
    title: options.title,
    env: { TERM: "xterm-256color" },
  };
  const lines: string[] = [JSON.stringify(header)];
  const frames = terminal.getWriteEvents();
  frames.forEach((data, index) => {
    const event: AsciicastEvent = [
      Number(((index + 1) * interval).toFixed(3)),
      "o",
      data,
    ];
    lines.push(JSON.stringify(event));
  });
  return `${lines.join("\n")}\n`;
}

/** Parse + validate an asciicast v2 document (header + frames). Throws if invalid. */
export function parseAsciicast(cast: string): {
  header: AsciicastHeader;
  events: AsciicastEvent[];
} {
  const rows = cast.split("\n").filter((line) => line.length > 0);
  if (rows.length === 0) throw new Error("empty asciicast");
  const header = JSON.parse(rows[0]) as AsciicastHeader;
  if (header.version !== 2) {
    throw new Error(`expected asciicast version 2, got ${header.version}`);
  }
  const events = rows.slice(1).map((row) => JSON.parse(row) as AsciicastEvent);
  for (const [time, code] of events) {
    if (typeof time !== "number" || code !== "o") {
      throw new Error(
        `invalid asciicast event: ${JSON.stringify([time, code])}`,
      );
    }
  }
  return { header, events };
}

export interface DumpedArtifacts {
  cast: string;
  viewport: string;
  scrollback: string;
  /** Absolute paths written, when `dir` was provided. */
  paths?: { cast: string; viewport: string; scrollback: string };
}

/**
 * Produce the three artifacts for a session. When `dir` is given, also writes
 * `<name>.cast` / `<name>.viewport.txt` / `<name>.scrollback.txt` there.
 */
export function dumpTuiArtifacts(
  terminal: VirtualTerminal,
  name: string,
  options: { dir?: string; title?: string } = {},
): DumpedArtifacts {
  const cast = toAsciicast(terminal, { title: options.title ?? name });
  const viewport = `${terminal.getViewport().join("\n")}\n`;
  const scrollback = `${terminal.getScrollBuffer().join("\n")}\n`;
  const result: DumpedArtifacts = { cast, viewport, scrollback };
  if (options.dir) {
    mkdirSync(options.dir, { recursive: true });
    const paths = {
      cast: join(options.dir, `${name}.cast`),
      viewport: join(options.dir, `${name}.viewport.txt`),
      scrollback: join(options.dir, `${name}.scrollback.txt`),
    };
    writeFileSync(paths.cast, cast);
    writeFileSync(paths.viewport, viewport);
    writeFileSync(paths.scrollback, scrollback);
    result.paths = paths;
  }
  return result;
}
