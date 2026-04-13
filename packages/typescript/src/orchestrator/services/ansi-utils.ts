/**
 * ANSI/terminal utility functions for processing PTY output.
 *
 * Pure functions — no state, no dependencies beyond the standard library.
 *
 * @module services/ansi-utils
 */

// ANSI escape sequence patterns for terminal output stripping.
// These intentionally match control characters (\x1b, \x00-\x1f, \x7f).
/* eslint-disable no-control-regex */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
const CURSOR_MOVEMENT = /\x1b\[\d*[CDABGdEF]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
const CURSOR_POSITION = /\x1b\[\d*(?:;\d+)?[Hf]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
const ERASE = /\x1b\[\d*[JK]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
const ALL_ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** Orphaned SGR fragments left when buffer boundaries split `\x1b[...m` sequences. */
const ORPHAN_SGR = /\[[\d;]*m/g;
const LONG_SPACES = / {3,}/g;

/** Apply all ANSI stripping patterns to a string */
function applyAnsiStrip(input: string): string {
  return (
    input
      // Pre-process: rejoin SGR sequences split across lines by chunk boundaries.
      // e.g. "[38;2;153;\n153;153m" → "[38;2;153;153;153m"
      .replace(/(\[[\d;]*)\r?\n([\d;]*m)/g, "$1$2")
      .replace(CURSOR_MOVEMENT, " ")
      .replace(CURSOR_POSITION, " ")
      .replace(ERASE, "")
      .replace(OSC, "")
      .replace(ALL_ANSI, "")
      .replace(CONTROL_CHARS, "")
      .replace(ORPHAN_SGR, "")
      .replace(LONG_SPACES, " ")
      .trim()
  );
}

/**
 * Strip ANSI escape sequences from raw terminal output for readable text.
 * Replaces cursor-forward codes with spaces (TUI uses these instead of actual spaces).
 */
export function stripAnsi(raw: string): string {
  return applyAnsiStrip(raw);
}

// ─── Chat-Ready Output Cleaning ───

/** Unicode spinner, box-drawing, and decorative characters used by CLI TUIs. */
const TUI_DECORATIVE =
  /[│╭╰╮╯─═╌║╔╗╚╝╠╣╦╩╬┌┐└┘├┤┬┴┼●○❮❯▶◀⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷✽✻✶✳✢⏺←→↑↓⬆⬇◆▪▫■□▲△▼▽◈⟨⟩⌘⏎⏏⌫⌦⇧⇪⌥·⎿✔◼█▌▐▖▗▘▝▛▜▟▙◐◑◒◓⏵]/g;

/**
 * Lines that are just CLI loading/thinking status — no meaningful content.
 * Claude Code uses random gerund spinner words ("Tomfoolering…", "Recombobulating…")
 * that rotate frequently. Requires an ellipsis (…/...) or status suffix
 * (parenthetical / "for Ns") — plain words like "Completed" won't match.
 */
const LOADING_LINE =
  /^\s*(?:[A-Z][a-z]+(?:-[a-z]+)?(?:ing|ed)\w*|thinking|Loading|processing)(?:…|\.{3})(?:\s*\(.*\)|\s+for\s+\d+[smh](?:\s+\d+[smh])*)?\s*$|^\s*(?:[A-Z][a-z]+(?:-[a-z]+)?(?:ing|ed)\w*|thinking|Loading|processing)\s+for\s+\d+[smh](?:\s+\d+[smh])*\s*$/;

/** Lines that are just token/timing metadata from the spinner status bar. */
const STATUS_LINE =
  /^\s*(?:\d+[smh]\s+\d+s?\s*·|↓\s*[\d.]+k?\s*tokens|·\s*↓|esc\s+to\s+interrupt|[Uu]pdate available|ate available|Run:\s+brew|brew\s+upgrade|\d+\s+files?\s+\+\d+\s+-\d+|ctrl\+\w|\+\d+\s+lines|Wrote\s+\d+\s+lines\s+to|\?\s+for\s+shortcuts|Cooked for|Baked for|Cogitated for)/i;

/** Claude Code tool execution markers — not meaningful for coordination decisions. */
const TOOL_MARKER_LINE =
  /^\s*(?:Bash|Write|Read|Edit|Glob|Grep|Search|TodoWrite|Agent)\s*\(.*\)\s*$/;

/** Git status/diff noise that's not meaningful for coordination. */
const GIT_NOISE_LINE =
  /^\s*(?:On branch\s+\w|Your branch is|modified:|new file:|deleted:|renamed:|Untracked files:|Changes (?:not staged|to be committed)|\d+\s+files?\s+changed.*(?:insertion|deletion))/i;

/** Codex/Claude launcher banners and trust screens that pollute failover prompts. */
const SESSION_BOOTSTRAP_NOISE_PATTERNS = [
  /^OpenAI Codex\b/i,
  /^model:\s/i,
  /^directory:\s/i,
  /^Tip:\s+New Try the Codex App\b/i,
  /^until .*Run ['"]codex app['"]/i,
  /Do you trust the contents of this directory/i,
  /higher risk of prompt injection/i,
  /Yes,\s*continue.*No,\s*quit/i,
  /^Press enter to continue$/i,
  /^Quick safety check:/i,
  /^Claude Code can make mistakes\./i,
  /^Claude Code(?:'ll| will)\s+be able to read, edit, and execute files here\.?$/i,
  /^\d+\.\s+Yes,\s*I trust this folder$/i,
  /^\d+\.\s+No,\s*exit$/i,
  /^Enter to confirm(?:\s+Esc to cancel)?$/i,
  /^Welcome back .*Run \/init to create a CLAUDE\.md file with instructions for Claude\./i,
  /^Your bash commands will be sandboxed\. Disable with \/sandbox\./i,
];

function isSessionBootstrapNoiseLine(line: string): boolean {
  return SESSION_BOOTSTRAP_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Clean terminal output for display in chat messages.
 *
 * Goes beyond {@link stripAnsi} by also removing:
 * - Unicode spinner/box-drawing/decorative characters from CLI TUIs
 * - Lines that are only loading/thinking status text
 * - Spinner status bar metadata (token counts, timing)
 * - Consecutive blank lines (collapsed to one)
 */
export function cleanForChat(raw: string): string {
  const stripped = applyAnsiStrip(raw);
  return stripped
    .replace(TUI_DECORATIVE, " ")
    .replace(/\xa0/g, " ")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false; // blank line — will re-add separators below
      if (LOADING_LINE.test(trimmed)) return false;
      if (STATUS_LINE.test(trimmed)) return false;
      if (TOOL_MARKER_LINE.test(trimmed)) return false;
      if (GIT_NOISE_LINE.test(trimmed)) return false;
      if (isSessionBootstrapNoiseLine(trimmed)) return false;
      // Lines with only whitespace/punctuation and no alphanumeric content
      if (!/[a-zA-Z0-9]/.test(trimmed)) return false;
      // Very short lines (≤3 chars) are likely TUI fragments
      if (trimmed.length <= 3) return false;
      return true;
    })
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FAILOVER_CONTEXT_NOISE_PATTERNS = [
  /^Accessing workspace:?$/i,
  /work from your team\)\. If not, take a moment to review what's in this folder first\.$/i,
  /(?:se)?curity guide$/i,
  /^Yes,\s*I trust this folder$/i,
  /^Claude Code v[\d.]+$/i,
  /^Tips for getting started$/i,
  /^Welcome back .*Run \/init to create a CLAUDE\.md file with instructions for Claude\.?$/i,
  /^Recent activity$/i,
  /^No recent activity$/i,
  /^.*\(\d+[MK]? context\)\s+Claude\b.*$/i,
  /^don'?t ask on \(shift\+tab to cycle\)$/i,
  /^\w+\s+\/effort$/i,
];

function isWorkdirEchoLine(line: string, workdir?: string): boolean {
  if (!workdir) return false;
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) return false;
  if (line === normalizedWorkdir || line === `/private${normalizedWorkdir}`) {
    return true;
  }
  const basename = normalizedWorkdir
    .split("/")
    .filter(Boolean)
    .at(-1);
  return Boolean(
    basename &&
      line.includes(basename) &&
      (/^\/(?:private\/)?/.test(line) || /^\/…\//.test(line)),
  );
}

/**
 * Failover prompts need stricter transcript sanitization than chat messages.
 * The replacement agent already gets the workspace path and failure reason
 * separately, so Claude/Codex trust screens, onboarding banners, and echoed
 * workspace selectors should be dropped here instead of being forwarded.
 */
export function cleanForFailoverContext(raw: string, workdir?: string): string {
  return cleanForChat(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !FAILOVER_CONTEXT_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !isWorkdirEchoLine(line, workdir))
    .join("\n")
    .trim();
}

/**
 * Extract meaningful artifacts (PR URLs, commit hashes, key results) from raw
 * terminal output.  Returns a compact summary suitable for chat messages,
 * without dumping raw TUI output.
 */
export function extractCompletionSummary(raw: string): string {
  const stripped = applyAnsiStrip(raw);
  const lines: string[] = [];

  // PR / issue URLs
  const prUrls = stripped.match(
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g,
  );
  if (prUrls) {
    for (const url of [...new Set(prUrls)]) lines.push(url);
  }

  // "Created pull request #N" style messages
  const prCreated = stripped.match(
    /(?:Created|Opened)\s+pull\s+request\s+#\d+[^\n]*/gi,
  );
  if (prCreated && !prUrls) {
    for (const m of prCreated) lines.push(m.trim());
  }

  // Commit hashes
  const commits = stripped.match(/(?:committed|commit)\s+[a-f0-9]{7,40}/gi);
  if (commits) {
    for (const m of [...new Set(commits)]) lines.push(m.trim());
  }

  // Files changed summary (e.g. "2 files changed, 15 insertions(+), 3 deletions(-)")
  const diffStat = stripped.match(
    /\d+\s+files?\s+changed.*?(?:insertion|deletion)[^\n]*/gi,
  );
  if (diffStat) {
    for (const m of diffStat) lines.push(m.trim());
  }

  return lines.join("\n");
}

/**
 * Extract a dev server URL from recent terminal output, if present.
 *
 * Looks for common patterns like:
 *   - http://localhost:3000
 *   - http://127.0.0.1:8080
 *   - http://0.0.0.0:5173
 *   - https://localhost:4200
 *
 * Returns the first match, or null if no dev server URL is found.
 */
export function extractDevServerUrl(raw: string): string | null {
  const stripped = applyAnsiStrip(raw);
  // Match local dev server URLs with a port number
  const match = stripped.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{1,5}[^\s)}\]'"`,]*/,
  );
  return match ? match[0] : null;
}

/**
 * Capture the agent's output since the last task was sent, cleaned for chat display.
 * Returns readable text with TUI noise removed, or empty string if no marker exists.
 *
 * Mutates `markers` by deleting the entry for `sessionId` after capture.
 */
export function captureTaskResponse(
  sessionId: string,
  buffers: Map<string, string[]>,
  markers: Map<string, number>,
): string {
  const buffer = buffers.get(sessionId);
  const marker = markers.get(sessionId);
  if (!buffer || marker === undefined) return "";

  const responseLines = buffer.slice(marker);
  markers.delete(sessionId);

  return cleanForChat(responseLines.join("\n"));
}

/**
 * Peek at the current task response without consuming the marker.
 * Useful for state reconciliation paths that need to inspect a response
 * before deciding whether to emit a synthetic completion event.
 */
export function peekTaskResponse(
  sessionId: string,
  buffers: Map<string, string[]>,
  markers: Map<string, number>,
): string {
  const buffer = buffers.get(sessionId);
  const marker = markers.get(sessionId);
  if (!buffer || marker === undefined) return "";
  return cleanForChat(buffer.slice(marker).join("\n"));
}
