/**
 * Detects a sub-agent that manufactured the input it was told to consume.
 * Under verify coaching ("prove the run output contains the result"), a weak
 * coding model that could not find `/etc/nubs-secret-config.yaml` wrote its
 * own `nubs-secret-config.yaml` with `version: 1.2.3`, pointed the script at
 * it, and the judge passed "1.2.3" to the user (live 2026-08-22). The task's
 * read targets are compared against the session's write ledger and shell
 * redirections by file stem; a hit is a fabricated input, never a pass.
 */

const READ_TARGET_RE =
  /\b(?:read|reads|reading|parse|parses|parsing|load|loads|loading|open|opens|opening|fetch|fetches|consume|consumes|from|in)\b[^\n]{0,60}?((?:\/|~\/|\.\/|[A-Za-z]:\\)?[\w.\\/-]*[\w-]\.(?:ya?ml|json|csv|tsv|txt|toml|ini|cfg|conf|xml|env|log|md|db|sqlite3?|parquet|xlsx?))\b/gi;

const SHELL_WRITE_TARGET_RE =
  /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&]+)/g;

export interface FabricatedInput {
  /** The file the task said to read (as written in the task). */
  target: string;
  /** The file the sub-agent wrote in its place. */
  wrote: string;
}

function stem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "").toLowerCase();
}

/** File-like tokens the task text asks the worker to READ. */
export function readTargetsFromTask(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(READ_TARGET_RE)) {
    const target = match[1]?.trim();
    if (target && !out.includes(target)) out.push(target);
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
): FabricatedInput | undefined {
  const targets = readTargetsFromTask(taskText);
  if (targets.length === 0) return undefined;
  const writes = [
    ...writtenPaths,
    ...shellCommands.flatMap((command) => shellWriteTargets(command)),
  ];
  for (const target of targets) {
    const targetStem = stem(target);
    if (!targetStem) continue;
    const wrote = writes.find((path) => stem(path) === targetStem);
    if (wrote) return { target, wrote };
  }
  return undefined;
}
