/**
 * Retains bounded child-process diagnostics while indexing every failing test file.
 * The formatted failure block makes tail truncation explicit and preserves a
 * complete, machine-readable file inventory even when detailed output is capped.
 */

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const FAILING_TEST_FILE_PATTERN =
  /(?:^|\s)FAIL\s+(?:\[[^\]\r\n]+\]\s+)?(?:\|[^|\r\n]+\|\s+)?([^\r\n]*?\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/g;

// Per-package parallel output retains this tail; the failure-file index below
// spans the entire child stream so the cap never hides which suites failed.
export const MAX_CAPTURED_OUTPUT_CHARS = 16_000;

function collectFailingTestFiles(line, files) {
  const plainLine = line.replace(ANSI_ESCAPE_PATTERN, "");
  for (const match of plainLine.matchAll(FAILING_TEST_FILE_PATTERN)) {
    files.add(match[1].trim());
  }
}

export function createCapturedTestOutput() {
  return {
    failingTestFiles: new Set(),
    omittedChars: 0,
    pendingLines: new Map(),
    retained: "",
  };
}

export function appendCapturedTestOutput(capture, chunk, source = "combined") {
  const value = String(chunk);
  const combinedLines = `${capture.pendingLines.get(source) ?? ""}${value}`;
  const lines = combinedLines.split(/\r?\n/);
  capture.pendingLines.set(source, lines.pop() ?? "");
  for (const line of lines) {
    collectFailingTestFiles(line, capture.failingTestFiles);
  }

  const next = `${capture.retained}${value}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    capture.retained = next;
    return;
  }

  const omittedNow = next.length - MAX_CAPTURED_OUTPUT_CHARS;
  capture.omittedChars += omittedNow;
  capture.retained = next.slice(omittedNow);
}

export function retainedCapturedTestOutput(capture) {
  return capture.retained;
}

export function formatCapturedTestOutput(capture, label) {
  for (const pendingLine of capture.pendingLines.values()) {
    collectFailingTestFiles(pendingLine, capture.failingTestFiles);
  }

  const retainedFiles = new Set();
  for (const line of capture.retained.split(/\r?\n/)) {
    collectFailingTestFiles(line, retainedFiles);
  }
  const omittedFailureCount = [...capture.failingTestFiles].filter(
    (file) => !retainedFiles.has(file),
  ).length;

  const sections = ["", `[eliza-test] ----- captured output: ${label} -----`];
  if (capture.omittedChars > 0) {
    sections.push(
      `[eliza-test] TRUNCATED ${capture.omittedChars} earlier character(s) omitted; ${omittedFailureCount} earlier failing test file(s) omitted from retained detail.`,
    );
  }
  sections.push(capture.retained);

  if (capture.failingTestFiles.size > 0) {
    const files = [...capture.failingTestFiles].sort();
    sections.push(
      `[eliza-test] ----- failing test files: ${label} (${files.length} total) -----`,
      ...files.map((file) => `[eliza-test] FAILING_FILE ${file}`),
      `[eliza-test] ----- end failing test files: ${label} -----`,
    );
  }
  sections.push(`[eliza-test] ----- end output: ${label} -----`, "");
  return sections.join("\n");
}
