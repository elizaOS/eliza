// asciicast v2 builder (issue #9969). Turns the raw-ANSI write stream recorded
// by the TUI e2e harness into a `.cast` file — the de-facto terminal
// screen-recording format (playable with `asciinema play`). This is the TUI
// lane's "video walkthrough" evidence per PR_EVIDENCE.md / #9944.
//
// Spec: https://docs.asciinema.org/manual/asciicast/v2/

export interface CastFrame {
  /** Seconds elapsed since recording start. */
  t: number;
  /** Raw terminal output chunk (ANSI included). */
  data: string;
}

export interface CastOptions {
  width: number;
  height: number;
  title?: string;
}

/** Build an asciicast v2 document from recorded output frames. */
export function buildAsciicast(
  frames: CastFrame[],
  options: CastOptions,
): string {
  const header: Record<string, unknown> = {
    version: 2,
    width: options.width,
    height: options.height,
  };
  if (options.title) header.title = options.title;
  const lines = [JSON.stringify(header)];
  for (const frame of frames) {
    lines.push(JSON.stringify([Number(frame.t.toFixed(3)), "o", frame.data]));
  }
  return `${lines.join("\n")}\n`;
}
