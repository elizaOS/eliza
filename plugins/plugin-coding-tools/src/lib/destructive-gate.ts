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

interface HeredocDeclaration {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

interface ParsedHeredocDelimiter {
  delimiter: string;
  quoted: boolean;
}

interface MaskedShellInput {
  executableCommand: string;
  unquotedHeredocBodies: string[];
}

interface NestedCommandInspection {
  commands: string[];
  unsafe: boolean;
}

const MAX_NESTED_EXPANSION_DEPTH = 16;

function hasTrailingLineContinuation(line: string): boolean {
  let backslashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function parseHeredocDelimiter(
  line: string,
  start: number,
): ParsedHeredocDelimiter | null {
  let cursor = start;
  let delimiter = "";
  let quote: string | null = null;
  let quoted = false;
  let wordStarted = false;

  while (cursor < line.length) {
    const ch = line[cursor] as string;
    if (quote) {
      if (ch === quote) {
        quote = null;
        cursor += 1;
        continue;
      }
      if (
        quote === '"' &&
        ch === "\\" &&
        cursor + 1 < line.length &&
        /[$`"\\]/.test(line[cursor + 1] as string)
      ) {
        cursor += 1;
      }
      delimiter += line[cursor] as string;
      cursor += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      wordStarted = true;
      quoted = true;
      quote = ch;
      cursor += 1;
      continue;
    }
    if (ch === "\\" && cursor + 1 < line.length) {
      wordStarted = true;
      quoted = true;
      cursor += 1;
      delimiter += line[cursor] as string;
      cursor += 1;
      continue;
    }
    if (/[\s|;&<>()]/.test(ch)) break;
    wordStarted = true;
    delimiter += ch;
    cursor += 1;
  }

  return quote === null && wordStarted ? { delimiter, quoted } : null;
}

function isInsideArrayAssignmentSubscript(
  line: string,
  operatorIndex: number,
): boolean {
  // Bash evaluates a balanced `name[...]` assignment as arithmetic before it
  // considers redirections. Be conservative about command position: declining
  // to mask a lookalike can only add confirmation, while masking one can hide
  // an executable line.
  let tokenStart = operatorIndex;
  while (tokenStart > 0 && !/[\s;|&()]/.test(line[tokenStart - 1] as string)) {
    tokenStart -= 1;
  }

  const prefix = line.slice(tokenStart, operatorIndex);
  const openingBracket = prefix.indexOf("[");
  if (
    openingBracket < 1 ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix.slice(0, openingBracket))
  ) {
    return false;
  }

  let bracketDepth = 0;
  for (
    let cursor = tokenStart + openingBracket;
    cursor < line.length;
    cursor += 1
  ) {
    const ch = line[cursor] as string;
    if (ch === "[") bracketDepth += 1;
    else if (ch === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        return /^(?:\+?=)/.test(line.slice(cursor + 1));
      }
    }
  }
  return false;
}

function heredocDeclarations(line: string): HeredocDeclaration[] {
  const declarations: HeredocDeclaration[] = [];
  let arithmeticDepth = 0;
  let legacyArithmeticDepth = 0;
  let parameterExpansionDepth = 0;
  let quote: string | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < line.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" && line[i + 1] === "(") {
      arithmeticDepth += 1;
      i += 1;
      continue;
    }
    if (arithmeticDepth > 0 && ch === ")" && line[i + 1] === ")") {
      arithmeticDepth -= 1;
      i += 1;
      continue;
    }
    if (arithmeticDepth > 0) continue;
    if (ch === "$" && line[i + 1] === "[") {
      legacyArithmeticDepth += 1;
      i += 1;
      continue;
    }
    if (legacyArithmeticDepth > 0) {
      if (ch === "[") legacyArithmeticDepth += 1;
      else if (ch === "]") legacyArithmeticDepth -= 1;
      continue;
    }
    if (ch === "$" && line[i + 1] === "{") {
      parameterExpansionDepth += 1;
      i += 1;
      continue;
    }
    if (parameterExpansionDepth > 0) {
      if (ch === "}") parameterExpansionDepth -= 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|&()]/.test(line[i - 1] as string)))
      break;
    if (ch !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;
    if (isInsideArrayAssignmentSubscript(line, i)) continue;

    let cursor = i + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;

    const parsed = parseHeredocDelimiter(line, cursor);
    if (parsed !== null) declarations.push({ ...parsed, stripTabs });
  }
  return declarations;
}

// Literal heredoc payload tokens are shell input rather than command
// positions. Preserve newlines so later executable lines remain segment
// boundaries, but hide literal payload bytes from the command and SQL
// classifiers. Unquoted bodies can evaluate nested expansions; those require
// their own recursive inspection rather than treating the whole body as a
// command list.
function maskHeredocBodies(command: string): MaskedShellInput {
  const lines = command.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const pending: HeredocDeclaration[] = [];
  let continuedBodyLine = "";
  let activeUnquotedBody = "";
  const unquotedHeredocBodies: string[] = [];

  const executableCommand = lines
    .map((line) => {
      const newline = line.endsWith("\r\n")
        ? "\r\n"
        : line.endsWith("\n")
          ? "\n"
          : line.endsWith("\r")
            ? "\r"
            : "";
      const content = newline ? line.slice(0, -newline.length) : line;
      const active = pending[0];
      if (active) {
        const comparable = active.stripTabs
          ? content.replace(/^\t+/, "")
          : content;
        const joinsNextLine =
          !active.quoted && hasTrailingLineContinuation(comparable);
        continuedBodyLine += joinsNextLine
          ? comparable.slice(0, -1)
          : comparable;
        const terminatesBody =
          !joinsNextLine && continuedBodyLine === active.delimiter;
        if (!active.quoted && !terminatesBody) activeUnquotedBody += line;
        if (!joinsNextLine) {
          if (terminatesBody) {
            pending.shift();
            if (!active.quoted) {
              unquotedHeredocBodies.push(activeUnquotedBody);
              activeUnquotedBody = "";
            }
          }
          continuedBodyLine = "";
        }
        return `${" ".repeat(content.length)}${newline}`;
      }
      // A physical newline escaped with a trailing backslash is part of the
      // declaration's logical command line, not the start of heredoc data.
      // Decline to mask this uncommon form rather than hide executable text.
      if (!hasTrailingLineContinuation(content)) {
        pending.push(...heredocDeclarations(content));
      }
      return line;
    })
    .join("");

  if (activeUnquotedBody) unquotedHeredocBodies.push(activeUnquotedBody);
  return { executableCommand, unquotedHeredocBodies };
}

function nestedCommands(
  source: string,
  shellQuotesAreSyntax: boolean,
): NestedCommandInspection {
  const commands: string[] = [];
  let quote: string | null = null;

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const ch = source[cursor] as string;
    if (shellQuotesAreSyntax && quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && cursor + 1 < source.length) {
      cursor += 1;
      continue;
    }
    if (shellQuotesAreSyntax && quote === null && ch === "'") {
      quote = "'";
      continue;
    }
    if (shellQuotesAreSyntax && ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (
      shellQuotesAreSyntax &&
      quote === null &&
      ch === "#" &&
      (cursor === 0 || /[\s;|&()]/.test(source[cursor - 1] as string))
    ) {
      while (
        cursor + 1 < source.length &&
        !/[\r\n]/.test(source[cursor + 1] as string)
      ) {
        cursor += 1;
      }
      continue;
    }

    if (ch === "`" && (!shellQuotesAreSyntax || quote !== "'")) {
      let end = cursor + 1;
      let body = "";
      for (; end < source.length; end += 1) {
        const nested = source[end] as string;
        if (nested === "\\" && end + 1 < source.length) {
          const escaped = source[end + 1] as string;
          if (!/[$`\\\r\n]/.test(escaped)) body += nested;
          body += escaped;
          end += 1;
          continue;
        }
        if (nested === "`") break;
        body += nested;
      }
      if (end >= source.length) return { commands, unsafe: true };
      commands.push(body);
      cursor = end;
      continue;
    }

    if (ch !== "$" || source[cursor + 1] !== "(") continue;
    // Arithmetic expansion is data, but command substitutions nested inside
    // it are still executable and will be found while scanning onward.
    if (source[cursor + 2] === "(") continue;

    let end = cursor + 2;
    let parenDepth = 1;
    let nestedBacktick = false;
    let nestedQuote: string | null = null;
    let body = "";
    for (; end < source.length; end += 1) {
      const nested = source[end] as string;
      if (nestedQuote === "'") {
        body += nested;
        if (nested === "'") nestedQuote = null;
        continue;
      }
      if (nested === "\\" && end + 1 < source.length) {
        body += nested;
        body += source[end + 1] as string;
        end += 1;
        continue;
      }
      if (nestedQuote === null && nested === "`") {
        nestedBacktick = !nestedBacktick;
        body += nested;
        continue;
      }
      if (nestedBacktick) {
        body += nested;
        continue;
      }
      if (nestedQuote === null && nested === "'") {
        nestedQuote = "'";
        body += nested;
        continue;
      }
      if (nested === '"') {
        nestedQuote = nestedQuote === '"' ? null : '"';
        body += nested;
        continue;
      }
      if (
        nestedQuote === null &&
        nested === "#" &&
        (end === cursor + 2 || /[\s;|&()]/.test(source[end - 1] as string))
      ) {
        while (end < source.length && !/[\r\n]/.test(source[end] as string)) {
          body += source[end] as string;
          end += 1;
        }
        if (end >= source.length) break;
        body += source[end] as string;
        continue;
      }
      if (nestedQuote === null && nested === "(") parenDepth += 1;
      else if (nestedQuote === null && nested === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) break;
      }
      if (parenDepth > MAX_NESTED_EXPANSION_DEPTH) {
        return { commands, unsafe: true };
      }
      body += nested;
    }
    if (end >= source.length || parenDepth !== 0) {
      return { commands, unsafe: true };
    }
    commands.push(body);
    cursor = end;
  }

  return { commands, unsafe: false };
}

function splitSegments(command: string): string[] {
  // Split shell list/pipeline operators while retaining quoted or backslash-
  // escaped characters in their current segment.
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[i + 1] as string;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch;
      current += command[i + 1] as string;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      if (ch === "&" && command[i + 1] === "&") i += 1;
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
  return classifyDestructiveCommandAtDepth(command, 0);
}

function classifyDestructiveCommandAtDepth(
  command: string,
  depth: number,
): DestructiveVerdict {
  if (depth > MAX_NESTED_EXPANSION_DEPTH) {
    return {
      destructive: true,
      reason: "nested shell expansion exceeds inspection depth",
      targets: ["nested shell expansion"],
    };
  }

  const { executableCommand, unquotedHeredocBodies } =
    maskHeredocBodies(command);
  const inspectionSources = [
    { shellQuotesAreSyntax: true, source: executableCommand },
    ...unquotedHeredocBodies.map((source) => ({
      shellQuotesAreSyntax: false,
      source,
    })),
  ];
  for (const inspectionSource of inspectionSources) {
    const nested = nestedCommands(
      inspectionSource.source,
      inspectionSource.shellQuotesAreSyntax,
    );
    if (nested.unsafe) {
      return {
        destructive: true,
        reason: "nested shell expansion could not be inspected safely",
        targets: ["nested shell expansion"],
      };
    }
    for (const nestedCommand of nested.commands) {
      const nestedVerdict = classifyDestructiveCommandAtDepth(
        nestedCommand,
        depth + 1,
      );
      if (nestedVerdict.destructive) return nestedVerdict;
    }
  }

  const sql = DROP_SQL.exec(executableCommand);
  if (sql) {
    return {
      destructive: true,
      reason: `drops ${sql[1]?.toLowerCase()}`,
      targets: [sql[2] ?? ""],
    };
  }
  for (const segment of splitSegments(executableCommand)) {
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
