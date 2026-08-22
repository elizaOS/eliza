/**
 * Detects a sub-agent that manufactured the input it was told to consume.
 * Under verify coaching ("prove the run output contains the result"), a weak
 * coding model that could not find `/etc/nubs-secret-config.yaml` wrote its
 * own `nubs-secret-config.yaml` with `version: 1.2.3`, pointed the script at
 * it, and the judge passed "1.2.3" to the user (live 2026-08-22). The task's
 * read targets are compared against the session's write ledger and shell
 * redirections by normalized path. Filename similarity is not evidence: two
 * different directories commonly contain the same configuration filename.
 */

const FILE_TOKEN =
  "((?:\\/|~\\/|\\.\\/|[A-Za-z]:\\\\)?[\\w.\\\\/-]*[\\w-]\\.(?:ya?ml|json|csv|tsv|txt|toml|ini|cfg|conf|xml|env|log|md|db|sqlite3?|parquet|xlsx?))\\b";
const READ_VERBS =
  "read|reads|reading|parse|parses|parsing|load|loads|loading|open|opens|opening|fetch|fetches|consume|consumes|from";
const WRITE_VERBS =
  "write|writes|save|saves|output|outputs|export|exports|store|stores|create|creates|generate|generates|produce|produces|emit|emits";
/** Up to 60 chars on one line that never cross a verb of the other class. */
const window = (blocked: string) => `(?:(?!\\b(?:${blocked})\\b)[^\\n]){0,60}?`;
const READ_TARGET_RE = new RegExp(
  `\\b(?:${READ_VERBS})\\b${window(WRITE_VERBS)}${FILE_TOKEN}`,
  "gi",
);
/** Files the task tells the worker to PRODUCE — never read targets. */
const WRITE_TARGET_RE = new RegExp(
  `\\b(?:${WRITE_VERBS})\\b${window(READ_VERBS)}${FILE_TOKEN}`,
  "gi",
);

const SHELL_WRITE_TARGET_RE =
  /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&]+)/g;

export interface FabricatedInput {
  /** The file the task said to read (as written in the task). */
  target: string;
  /** The file the sub-agent wrote in its place. */
  wrote: string;
}

export interface InputBaseline {
  path: string;
  existed: boolean;
  sha256?: string;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/** File-like tokens the task text asks the worker to READ. */
export function readTargetsFromTask(text: string): string[] {
  const produced = new Set<string>();
  for (const match of text.matchAll(WRITE_TARGET_RE)) {
    const target = match[1]?.trim();
    if (target) produced.add(target.toLowerCase());
  }
  const out: string[] = [];
  for (const match of text.matchAll(READ_TARGET_RE)) {
    const target = match[1]?.trim();
    if (
      target &&
      !produced.has(target.toLowerCase()) &&
      !out.includes(target)
    ) {
      out.push(target);
    }
  }
  return out;
}

/** Paths a shell command line writes to via redirection or tee. */
export function shellWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(SHELL_WRITE_TARGET_RE)) {
    const target = match[1];
    if (target && target !== "/dev/null" && !out.includes(target)) {
      out.push(target);
    }
  }
  return out;
}

export function detectFabricatedInput(
  taskText: string,
  writtenPaths: readonly string[],
  shellCommands: readonly string[],
  baselines: readonly InputBaseline[],
): FabricatedInput | undefined {
  const targets = readTargetsFromTask(taskText);
  if (targets.length === 0) return undefined;
  const writes = [
    ...writtenPaths,
    ...shellCommands.flatMap((command) => shellWriteTargets(command)),
  ];
  for (const target of targets) {
    const normalizedTarget = normalizedPath(target);
    if (!normalizedTarget) continue;
    const baseline = baselines.find(
      (entry) => normalizedPath(entry.path) === normalizedTarget,
    );
    // A write is only fabrication evidence when the requested input was
    // captured as absent before execution. Missing baseline is unknown, not a
    // guilty verdict; an existing file may legitimately be rewritten.
    if (!baseline || baseline.existed) continue;
    const wrote = writes.find(
      (path) => normalizedPath(path) === normalizedTarget,
    );
    if (wrote) return { target, wrote };
  }
  return undefined;
}
