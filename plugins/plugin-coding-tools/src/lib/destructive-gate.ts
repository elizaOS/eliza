/**
 * Destructive-bulk command classifier for the chat-path SHELL gate. Decides
 * whether a command is an irreversible bulk operation (recursive delete, disk
 * overwrite, database drop) that must be confirmed by the user before it runs.
 * This is a confirmation gate, not a capability refusal: single-item writes and
 * ordinary commands never fire it, and the planner re-issues the same command
 * with confirm=true after the user says yes. Classification is on the command
 * string itself (ground truth), never on conversational text.
 */

export interface DestructiveVerdict {
  destructive: boolean;
  /** Human-readable reason, e.g. "recursive delete". */
  reason?: string;
  /** The specific targets (paths/db names) the operation would destroy. */
  targets: string[];
}

const RECURSIVE_RM_FLAG = /^-[a-z]*[rR][a-z]*$/;
const FORCE_ONLY_FLAG = /^-[a-z]*f[a-z]*$/;

// GNU getopt accepts an unambiguous long-option prefix, so `--rec` and `--f`
// have the same effect as their complete spellings.
function isLongOption(arg: string, option: string): boolean {
  return arg.length > 2 && option.startsWith(arg);
}

function isRecursiveRmFlag(arg: string): boolean {
  return isLongOption(arg, "--recursive") || RECURSIVE_RM_FLAG.test(arg);
}
function isForceRmFlag(arg: string): boolean {
  return isLongOption(arg, "--force") || FORCE_ONLY_FLAG.test(arg);
}

function parseRmArguments(rest: readonly string[]): {
  force: boolean;
  paths: string[];
  recursive: boolean;
} {
  let force = false;
  let parsingOptions = true;
  let recursive = false;
  const paths: string[] = [];

  for (const arg of rest) {
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
    } else if (parsingOptions && isRecursiveRmFlag(arg)) {
      recursive = true;
    } else if (parsingOptions && isForceRmFlag(arg)) {
      force = true;
    } else if (!parsingOptions || !arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  return { force, paths, recursive };
}
const POWERSHELL_RECURSE_FLAG = /^-(?:r|re|rec|recu|recur|recurs|recurse)$/i;
const POWERSHELL_REMOVE_ITEM_BINS = new Set([
  "remove-item",
  "del",
  "erase",
  "rd",
  "ri",
  "rmdir",
]);
const DESTRUCTIVE_BINS = new Set(["mkfs", "shred", "wipefs"]);
const DROP_SQL = /\bdrop\s+(database|table|schema)\s+(\S+)/i;

function splitSegments(command: string): string[] {
  // Chain + pipeline split; quotes are respected coarsely — a metacharacter
  // inside quotes stays put because we only split on unquoted operators.
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || (ch === "&" && command[i + 1] === "&")) {
      segments.push(current);
      current = "";
      if (ch === "&") i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

export function classifyDestructiveCommand(
  command: string,
): DestructiveVerdict {
  const sql = DROP_SQL.exec(command);
  if (sql) {
    return {
      destructive: true,
      reason: `drops ${sql[1]?.toLowerCase()}`,
      targets: [sql[2] ?? ""],
    };
  }
  for (const segment of splitSegments(command)) {
    const argv = tokens(segment);
    // env-var prefixes (FOO=bar cmd …) precede the executable
    let i = 0;
    while (
      i < argv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] as string)
    )
      i += 1;
    const bin = (argv[i] ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const rest = argv.slice(i + 1);

    if (bin === "rm") {
      const { force, paths, recursive } = parseRmArguments(rest);
      if (recursive) {
        return {
          destructive: true,
          reason: "recursive delete",
          targets: paths,
        };
      }
      // rm -f on a glob is bulk too; single explicit path is not.
      if (force && paths.some((p) => p.includes("*"))) {
        return {
          destructive: true,
          reason: "forced glob delete",
          targets: paths,
        };
      }
    }
    if (POWERSHELL_REMOVE_ITEM_BINS.has(bin)) {
      const recursive = rest.some((arg) => POWERSHELL_RECURSE_FLAG.test(arg));
      if (recursive) {
        return {
          destructive: true,
          reason: "recursive delete",
          targets: rest.filter((arg) => !arg.startsWith("-")),
        };
      }
    }
    if (
      bin === "find" &&
      (rest.includes("-delete") || rest.join(" ").includes("-exec rm"))
    ) {
      return {
        destructive: true,
        reason: "bulk find-delete",
        targets: rest.filter((a) => !a.startsWith("-")).slice(0, 3),
      };
    }
    if (bin === "dd") {
      const of = rest.find((a) => a.startsWith("of=/dev/"));
      if (of) {
        return {
          destructive: true,
          reason: "raw device overwrite",
          targets: [of],
        };
      }
    }
    if (DESTRUCTIVE_BINS.has(bin) || bin.startsWith("mkfs.")) {
      return {
        destructive: true,
        reason: `${bin} destroys its target`,
        targets: rest.filter((a) => !a.startsWith("-")),
      };
    }
  }
  return { destructive: false, targets: [] };
}
