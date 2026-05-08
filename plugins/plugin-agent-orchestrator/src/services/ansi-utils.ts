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
const PATCH_MARKER_LINE =
  /^(?:diff --git\b|index\s+[a-f0-9]{7,}\.\.[a-f0-9]{7,}|@@\s|---\s+[ab]\/|\+\+\+\s+[ab]\/)/;
const PATCH_ADDED_REMOVED_LINE = /^[+-]\s/;
const SOURCE_PUNCTUATION_LINE =
  /[{}();=]|\b(?:const|let|var|function|return|class|import|export)\b/;
const PUBLIC_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`)\]]*)?/gi;
const ASSISTANT_FINAL_MARKER_LINE =
  /^(?:codex|claude|claude code|gemini|opencode|openai)$/i;
const FINAL_BLOCK_STOP_LINE =
  /^(?:diff --git\b|exec\b|tokens used\b|thinking\b|error:\s|warning:\s|index\s+[a-f0-9]{7,}\.\.[a-f0-9]{7,}|@@\s|---\s+[ab]\/|\+\+\+\s+[ab]\/)/i;
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

function isLikelyRawPatchOrSourceDump(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 8) return false;

  if (lines.some((line) => PATCH_MARKER_LINE.test(line))) {
    return true;
  }

  const patchLines = lines.filter((line) =>
    PATCH_ADDED_REMOVED_LINE.test(line),
  );
  const addedPatchLines = patchLines.filter((line) => line.startsWith("+ "));
  const removedPatchLines = patchLines.filter((line) => line.startsWith("- "));
  const sourceLikePatchLines = patchLines.filter((line) =>
    SOURCE_PUNCTUATION_LINE.test(line),
  );
  return (
    addedPatchLines.length > 0 &&
    removedPatchLines.length > 0 &&
    patchLines.length >= 5 &&
    patchLines.length / lines.length >= 0.8 &&
    sourceLikePatchLines.length >= Math.max(3, Math.ceil(patchLines.length * 0.6))
  );
}

function extractAssistantFinalBlock(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ASSISTANT_FINAL_MARKER_LINE.test(lines[i])) continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) {
        if (block.length > 0) block.push("");
        continue;
      }
      if (FINAL_BLOCK_STOP_LINE.test(line)) break;
      block.push(line);
    }
    const text = block.join("\n").trim();
    if (
      text &&
      !isLikelyRawPatchOrSourceDump(text) &&
      !isSessionBootstrapNoiseLine(text)
    ) {
      return formatMarkdownTablesForChat(
        closeUnbalancedMarkdownFences(
          dedupeCompletionBlockLines(block).join("\n").trim(),
        ),
      );
    }
  }
  return "";
}

function lineContainsPublicUrl(line: string): boolean {
  PUBLIC_URL_RE.lastIndex = 0;
  return PUBLIC_URL_RE.test(line);
}

function normalizeUrlForDedupe(url: string): string {
  return url.trim().replace(/[`.,;:!?]+$/u, "");
}

function unwrapInlineCodeUrls(line: string): string {
  return line.replace(
    /`(https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^`\s<>"')\]]*)?)`/giu,
    "$1",
  );
}

function normalizeCompletionLineForDedupe(line: string): string {
  return unwrapInlineCodeUrls(line)
    .replace(PUBLIC_URL_RE, (url) => normalizeUrlForDedupe(url).toLowerCase())
    .replace(/[→←]/g, " ")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}:/#.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shouldDedupeCompletionLine(line: string, key: string): boolean {
  return key.length >= 8 || line.includes(":") || lineContainsPublicUrl(line);
}

function compactCompletionBlankLines(lines: string[]): string[] {
  const compacted: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (compacted.length > 0 && compacted.at(-1)?.trim()) {
        compacted.push("");
      }
      continue;
    }
    compacted.push(line);
  }

  while (compacted.length > 0 && !compacted.at(-1)?.trim()) {
    compacted.pop();
  }

  return compacted;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    trimmed.slice(1, -1).includes("|")
  );
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s+/g, "")))
  );
}

function formatMarkdownTableRowsForChat(rows: string[]): string[] {
  if (rows.length < 2 || isMarkdownTableSeparatorRow(rows[0])) {
    return rows;
  }

  const headers = parseMarkdownTableRow(rows[0]);
  const bodyRows = rows
    .slice(isMarkdownTableSeparatorRow(rows[1]) ? 2 : 1)
    .filter((row) => !isMarkdownTableSeparatorRow(row))
    .map(parseMarkdownTableRow);

  if (headers.length < 2 || bodyRows.length === 0) {
    return rows;
  }

  const formattedRows = bodyRows.map((row) => {
    const rowLabel = row[0] || headers[0] || "row";
    const details = headers
      .slice(1)
      .map((header, index) => {
        const value = row[index + 1];
        return value ? `${header || `column ${index + 2}`}: ${value}` : "";
      })
      .filter(Boolean);
    return details.length > 0 ? `- ${rowLabel}: ${details.join(", ")}` : "";
  });

  return formattedRows.every(Boolean) ? formattedRows : rows;
}

export function formatMarkdownTablesForChat(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.trim();
    if (fence.startsWith("```")) {
      inFence = !inFence || !/^```\s*$/u.test(fence);
      result.push(line);
      continue;
    }

    if (!inFence && isMarkdownTableRow(line)) {
      const tableRows = [line];
      while (index + 1 < lines.length && isMarkdownTableRow(lines[index + 1])) {
        tableRows.push(lines[index + 1]);
        index += 1;
      }
      result.push(...formatMarkdownTableRowsForChat(tableRows));
      continue;
    }

    result.push(line);
  }

  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBareUrlLineAfterValueHeading(
  line: string,
  previousLine: string,
): boolean {
  const matches = line.match(PUBLIC_URL_RE) ?? [];
  if (
    matches.length !== 1 ||
    line.trim() !== normalizeUrlForDedupe(matches[0])
  ) {
    return false;
  }
  return isSummarySectionHeadingLine(previousLine);
}

function isSummaryLabelLine(line: string): boolean {
  return /^(?:[-*]\s+)?[\p{L}\p{N}][^:\n]{0,80}:\s+\S/u.test(
    unwrapInlineCodeUrls(line).trim(),
  );
}

function isBulletSummaryLine(line: string): boolean {
  return /^[-*]\s+\S/u.test(unwrapInlineCodeUrls(line).trim());
}

function isSummarySectionHeadingLine(line: string): boolean {
  const trimmed = unwrapInlineCodeUrls(line).trim();
  return (
    trimmed.length > 1 &&
    trimmed.length <= 120 &&
    /[\p{L}\p{N}]/u.test(trimmed) &&
    /:\s*$/u.test(trimmed) &&
    !SOURCE_PUNCTUATION_LINE.test(trimmed)
  );
}

function isConciseHeadingValueLine(line: string): boolean {
  const trimmed = unwrapInlineCodeUrls(line).trim();
  if (!trimmed || trimmed.length > 280 || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return false;
  }
  if (
    PATCH_MARKER_LINE.test(trimmed) ||
    TOOL_MARKER_LINE.test(trimmed) ||
    GIT_NOISE_LINE.test(trimmed) ||
    FINAL_BLOCK_STOP_LINE.test(trimmed)
  ) {
    return false;
  }
  if (
    /^\s*(?:const|let|var|function|return|class|import|export)\b/u.test(trimmed)
  ) {
    return false;
  }
  if (/[;=]\s*$/u.test(trimmed)) {
    return false;
  }
  return true;
}

function isSentenceLikeSummaryLine(line: string): boolean {
  const trimmed = unwrapInlineCodeUrls(line).trim();
  return (
    trimmed.length <= 280 &&
    /[\p{L}\p{N}]/u.test(trimmed) &&
    /[.!?]$/u.test(trimmed)
  );
}

function isStructuredSummaryLine(line: string): boolean {
  const trimmed = unwrapInlineCodeUrls(line).trim();
  return (
    lineContainsPublicUrl(trimmed) ||
    isSummaryLabelLine(trimmed) ||
    isSummarySectionHeadingLine(trimmed) ||
    isBulletSummaryLine(trimmed) ||
    isSentenceLikeSummaryLine(trimmed)
  );
}

function isConciseUserFacingSummary(
  text: string,
  lines: readonly string[],
): boolean {
  if (!text || text.length > 4000 || lines.length < 1 || lines.length > 24) {
    return false;
  }
  if (isLikelyRawPatchOrSourceDump(text)) {
    return false;
  }
  if (
    lines.some(
      (line) =>
        PATCH_MARKER_LINE.test(line) ||
        TOOL_MARKER_LINE.test(line) ||
        GIT_NOISE_LINE.test(line),
    )
  ) {
    return false;
  }

  const meaningfulLines = lines.filter((line) => /[\p{L}\p{N}]/u.test(line));
  if (meaningfulLines.length === 0) {
    return false;
  }

  if (meaningfulLines.some(lineContainsPublicUrl)) {
    return true;
  }

  const summaryShapedLines = meaningfulLines.filter(
    (line) =>
      isSummaryLabelLine(line) ||
      isBulletSummaryLine(line) ||
      isSentenceLikeSummaryLine(line),
  );
  const mostlyShortLines =
    meaningfulLines.filter((line) => line.length <= 280).length /
      meaningfulLines.length >=
    0.75;

  return (
    mostlyShortLines &&
    summaryShapedLines.length >= Math.min(2, meaningfulLines.length)
  );
}

function dedupeCompletionBlockLines(lines: string[]): string[] {
  const urlsWithContext = new Set<string>();
  const seenUrls = new Set<string>();
  const seenLineKeys = new Set<string>();
  const result: string[] = [];
  const normalizedLines = lines.map(unwrapInlineCodeUrls);

  for (const line of normalizedLines) {
    const matches = line.match(PUBLIC_URL_RE) ?? [];
    const normalizedMatches = matches.map(normalizeUrlForDedupe);
    const isBareUrlLine =
      normalizedMatches.length === 1 && line.trim() === normalizedMatches[0];
    if (isBareUrlLine) continue;

    for (const normalized of normalizedMatches) {
      urlsWithContext.add(normalized);
    }
  }

  let inFence = false;
  let previousMeaningfulLine = "";
  for (const line of normalizedLines) {
    const fence = line.trim();
    if (fence.startsWith("```")) {
      inFence = !inFence || !/^```\s*$/.test(fence);
      result.push(line);
      if (line.trim()) previousMeaningfulLine = line;
      continue;
    }

    const matches = line.match(PUBLIC_URL_RE) ?? [];
    const normalizedMatches = matches.map(normalizeUrlForDedupe);
    const isBareHeadingValueUrl = isBareUrlLineAfterValueHeading(
      line,
      previousMeaningfulLine,
    );
    const isBareRepeatedUrl =
      normalizedMatches.length === 1 &&
      line.trim() === normalizedMatches[0] &&
      !isBareHeadingValueUrl &&
      (seenUrls.has(normalizedMatches[0]) ||
        urlsWithContext.has(normalizedMatches[0]));
    if (isBareRepeatedUrl) continue;

    if (!inFence && line.trim()) {
      const key = normalizeCompletionLineForDedupe(line);
      if (
        key &&
        seenLineKeys.has(key) &&
        shouldDedupeCompletionLine(line, key)
      ) {
        continue;
      }
      if (key && shouldDedupeCompletionLine(line, key)) {
        seenLineKeys.add(key);
      }
    }

    result.push(line);
    if (line.trim()) previousMeaningfulLine = line;
    for (const normalized of normalizedMatches) {
      seenUrls.add(normalized);
    }
  }

  return compactCompletionBlankLines(result);
}

function markdownFenceInfo(line: string): string | null {
  const match = line.trim().match(/^```\s*([^\s`]*)/u);
  return match ? match[1].toLowerCase() : null;
}

function isPlainTextOutputFence(info: string): boolean {
  return (
    info === "" ||
    info === "text" ||
    info === "txt" ||
    info === "output" ||
    info === "log" ||
    info === "console" ||
    info === "terminal"
  );
}

function isLikelyCommandOutputLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/[.!?]$/u.test(trimmed)) return false;
  const columns = trimmed.split(/\s+/);
  if (columns.length < 4) return false;
  return /(?:\d|%|\/|:)/u.test(trimmed);
}

function shouldCloseTextFenceBeforeSummaryLine(
  fenceInfo: string,
  fenceLines: readonly string[],
  line: string,
): boolean {
  if (!isPlainTextOutputFence(fenceInfo)) return false;

  const meaningfulFenceLines = fenceLines.filter((fenceLine) =>
    fenceLine.trim(),
  );
  if (meaningfulFenceLines.length < 1) return false;
  if (!meaningfulFenceLines.some(isLikelyCommandOutputLine)) return false;

  const trimmed = unwrapInlineCodeUrls(line).trim();
  if (!trimmed || isLikelyCommandOutputLine(trimmed)) return false;
  return (
    isSummaryLabelLine(trimmed) ||
    isBulletSummaryLine(trimmed) ||
    isSentenceLikeSummaryLine(trimmed)
  );
}

export function closeUnbalancedMarkdownFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const fixedLines: string[] = [];
  let openFence = false;
  let openFenceInfo = "";
  let openFenceLines: string[] = [];

  for (const line of trimmed.split("\n")) {
    const fence = line.trim();
    if (!fence.startsWith("```")) {
      if (
        openFence &&
        shouldCloseTextFenceBeforeSummaryLine(
          openFenceInfo,
          openFenceLines,
          line,
        )
      ) {
        fixedLines.push("```");
        openFence = false;
        openFenceInfo = "";
        openFenceLines = [];
      }
      fixedLines.push(line);
      if (openFence) {
        openFenceLines.push(line);
      }
      continue;
    }

    if (!openFence) {
      openFence = true;
      openFenceInfo = markdownFenceInfo(line) ?? "";
      openFenceLines = [];
      fixedLines.push(line);
      continue;
    }

    if (/^```\s*$/.test(fence)) {
      openFence = false;
      openFenceInfo = "";
      openFenceLines = [];
      fixedLines.push(line);
      continue;
    }

    // A second fenced opener such as ```text while already inside a fence is
    // usually a model-generated missing close. Close the previous block before
    // preserving the next one.
    fixedLines.push("```");
    fixedLines.push(line);
    openFenceInfo = markdownFenceInfo(line) ?? "";
    openFenceLines = [];
  }

  if (openFence) {
    fixedLines.push("```");
  }

  return fixedLines.join("\n").trim();
}

function extractStructuredCompletionBlock(lines: string[]): string {
  const normalized = lines.map((line) => line.trim());
  for (let i = normalized.length - 1; i >= 0; i--) {
    const line = normalized[i];
    if (!lineContainsPublicUrl(line)) continue;

    let start = i;
    const scanFloor = Math.max(0, i - 30);
    for (let j = i; j >= scanFloor; j--) {
      const current = normalized[j];
      if (!current) continue;
      if (FINAL_BLOCK_STOP_LINE.test(current)) break;
      if (isStructuredSummaryLine(current)) {
        start = j;
        continue;
      }
      if (
        j > 0 &&
        isSummarySectionHeadingLine(normalized[j - 1]) &&
        isConciseHeadingValueLine(current)
      ) {
        start = j - 1;
        j -= 1;
        continue;
      }
      if (j < i) break;
    }

    const block: string[] = [];
    for (let j = start; j < normalized.length; j++) {
      const current = normalized[j];
      if (!current) {
        if (block.length > 0) block.push("");
        continue;
      }
      if (block.length > 0 && FINAL_BLOCK_STOP_LINE.test(current)) break;
      block.push(current);
    }

    const text = dedupeCompletionBlockLines(block).join("\n").trim();
    const textLines = text.split("\n").filter((textLine) => textLine.trim());
    if (
      lineContainsPublicUrl(text) &&
      isConciseUserFacingSummary(text, textLines)
    ) {
      return formatMarkdownTablesForChat(closeUnbalancedMarkdownFences(text));
    }
  }
  return "";
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
  const basename = normalizedWorkdir.split("/").filter(Boolean).at(-1);
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
    .filter(
      (line) =>
        !FAILOVER_CONTEXT_NOISE_PATTERNS.some((pattern) => pattern.test(line)),
    )
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
  const strippedLines = stripped.split("\n").map((line) => line.trim());
  const assistantFinalBlock = extractAssistantFinalBlock(strippedLines);
  if (assistantFinalBlock) {
    return assistantFinalBlock;
  }
  const structuredCompletionBlock =
    extractStructuredCompletionBlock(strippedLines);
  if (structuredCompletionBlock) {
    return structuredCompletionBlock;
  }
  const lines: string[] = [];
  const artifactText = strippedLines.slice(-80).join("\n");

  // PR / issue URLs
  const prUrls = artifactText.match(
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g,
  );
  if (prUrls) {
    for (const url of [...new Set(prUrls)]) lines.push(url);
  }

  // "Created pull request #N" style messages
  const prCreated = artifactText.match(
    /(?:Created|Opened)\s+pull\s+request\s+#\d+[^\n]*/gi,
  );
  if (prCreated && !prUrls) {
    for (const m of prCreated) lines.push(m.trim());
  }

  // Commit hashes
  const commits = artifactText.match(/(?:committed|commit)\s+[a-f0-9]{7,40}/gi);
  if (commits) {
    for (const m of new Set(commits)) lines.push(m.trim());
  }

  // Files changed summary (e.g. "2 files changed, 15 insertions(+), 3 deletions(-)")
  const diffStat = artifactText.match(
    /\d+\s+files?\s+changed.*?(?:insertion|deletion)[^\n]*/gi,
  );
  if (diffStat) {
    for (const m of diffStat) lines.push(m.trim());
  }

  const publicUrls = artifactText.match(PUBLIC_URL_RE);
  if (publicUrls) {
    for (const url of new Set(publicUrls)) {
      const normalizedUrl = normalizeUrlForDedupe(url);
      const alreadyIncluded = lines.some((line) =>
        line.includes(normalizedUrl),
      );
      if (!url.includes("github.com/") && !alreadyIncluded) {
        lines.push(url);
      }
    }
  }

  return formatMarkdownTablesForChat(
    closeUnbalancedMarkdownFences(lines.join("\n")),
  );
}

export function summarizeUserFacingTurnOutput(raw: string): string {
  const strippedLines = applyAnsiStrip(raw)
    .split("\n")
    .map((line) => line.trim());
  const assistantFinalBlock = extractAssistantFinalBlock(strippedLines);
  if (assistantFinalBlock) {
    return assistantFinalBlock;
  }
  const structuredCompletionBlock =
    extractStructuredCompletionBlock(strippedLines);
  if (structuredCompletionBlock) {
    return structuredCompletionBlock;
  }

  const cleanedLines = cleanForChat(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const cleaned = formatMarkdownTablesForChat(
    closeUnbalancedMarkdownFences(
      dedupeCompletionBlockLines(cleanedLines).join("\n").trim(),
    ),
  );

  if (isConciseUserFacingSummary(cleaned, cleanedLines)) {
    return cleaned;
  }

  const artifactSummary = extractCompletionSummary(raw).trim();
  if (artifactSummary) {
    return artifactSummary;
  }

  if (!cleaned) {
    return "";
  }

  if (isLikelyRawPatchOrSourceDump(cleaned)) {
    return "Task agent completed but did not produce a user-facing final summary.";
  }

  return cleaned;
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
