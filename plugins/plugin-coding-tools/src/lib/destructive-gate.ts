/**
 * Classifies shell programs that need explicit confirmation before execution.
 * Its bounded dialect-aware scanner follows command boundaries, quoting,
 * substitutions, and nested evaluators; syntax it cannot prove safe fails to
 * confirmation instead of silently bypassing the chat-path safety gate.
 */

export interface DestructiveVerdict {
  destructive: boolean;
  reason?: string;
  targets: string[];
}

export type ShellDialect = "posix" | "powershell";

interface Word {
  kind: "word";
  value: string;
  dynamic: boolean;
  glob: boolean;
}

interface Operator {
  kind: "operator" | "redirect";
  value: string;
}

type Token = Word | Operator;
interface Budget {
  depth: number;
  tokens: number;
}
interface Lexed {
  tokens: Token[];
  verdict?: DestructiveVerdict;
  error?: string;
}

const MAX_CHARS = 65_536;
const MAX_TOKENS = 4_096;
const MAX_DEPTH = 12;
const RECURSIVE_RM_FLAG = /^-[a-z]*[rR][a-z]*$/;
const FORCE_RM_FLAG = /^-[a-z]*f[a-z]*$/;
const PS_RECURSE_FLAG =
  /^-(?:r|re|rec|recu|recur|recurs|recurse)(?::(?:\$?true|1))?$/i;
const PS_FORCE_FLAG = /^-(?:f|fo|for|forc|force)(?::(?:\$?true|1))?$/i;
const PS_REMOVE = new Set([
  "remove-item",
  "del",
  "erase",
  "rd",
  "ri",
  "rm",
  "rmdir",
]);
const DESTRUCTIVE_BINS = new Set(["mkfs", "shred", "wipefs"]);
const POSIX_SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const SQL_RUNNERS = new Set(["psql", "mysql", "mariadb"]);
const POSIX_COMMAND_PREFIXES = new Set([
  "!",
  "coproc",
  "do",
  "elif",
  "else",
  "if",
  "noglob",
  "then",
  "until",
  "while",
]);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?=/;
const DROP_SQL =
  /\bdrop\s+(database|table|schema)\s+(?:if\s+exists\s+)?([^\s;]+)/i;

const safe = (): DestructiveVerdict => ({ destructive: false, targets: [] });
const unproved = (reason: string): DestructiveVerdict => ({
  destructive: true,
  reason: `shell syntax requires confirmation (${reason})`,
  targets: [],
});

function binName(value: string): string {
  return (value.split(/[\\/]/).pop() ?? "")
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "");
}

function endsWithLineContinuation(line: string): boolean {
  let count = 0;
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (line[index] !== "\\") break;
    count += 1;
  }
  return count % 2 === 1;
}

/**
 * Scans a balanced arithmetic construct whose body is data for
 * classification. Quoting, command substitution, and statement separators
 * inside the body defeat static proof (the shell may backtrack to a command
 * reading), so they refuse the arithmetic reading instead of guessing.
 */
function arithmeticSpan(
  source: string,
  start: number,
  open: string,
  close: string,
  initialDepth: number,
): { end: number } | undefined {
  let depth = initialDepth;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] as string;
    if (
      char === "'" ||
      char === '"' ||
      char === "`" ||
      char === ";" ||
      char === "\\" ||
      (char === "$" && source[index + 1] === "(")
    ) {
      return undefined;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { end: index };
    }
  }
  return undefined;
}

/**
 * Accepts only token sequences that a shell must evaluate as arithmetic.
 * Adjacent operands are rejected because they are the signature of a body
 * the shell would refuse as arithmetic and re-read as executable commands.
 */
function isStaticArithmetic(body: string): boolean {
  const pattern =
    /\s+|[0-9]+|\$?[A-Za-z_][A-Za-z0-9_]*|\*\*|<<=?|>>=?|<=|>=|==|!=|&&|\|\||[-+*/%<>=!&|^~?:,()]=?/y;
  let depth = 0;
  let previousOperand = false;
  let index = 0;
  while (index < body.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(body);
    if (!match || match.index !== index || match[0].length === 0) return false;
    const token = match[0];
    index += token.length;
    if (/^\s+$/.test(token)) continue;
    if (token === "(") {
      if (previousOperand) return false;
      depth += 1;
      continue;
    }
    if (token === ")") {
      if (depth === 0) return false;
      depth -= 1;
      previousOperand = true;
      continue;
    }
    if (/^[0-9$A-Za-z_]/.test(token)) {
      if (previousOperand) return false;
      previousOperand = true;
    } else {
      previousOperand = false;
    }
  }
  return depth === 0;
}

function addToken(result: Lexed, budget: Budget, token: Token): boolean {
  budget.tokens += 1;
  if (budget.tokens > MAX_TOKENS) {
    result.error = "token limit exceeded";
    return false;
  }
  result.tokens.push(token);
  return true;
}

function nested(
  source: string,
  dialect: ShellDialect,
  budget: Budget,
): DestructiveVerdict {
  if (budget.depth >= MAX_DEPTH) return unproved("nesting limit exceeded");
  const child = { depth: budget.depth + 1, tokens: budget.tokens };
  const verdict = scan(source, dialect, child);
  budget.tokens = child.tokens;
  return verdict;
}

function recordNested(result: Lexed, verdict: DestructiveVerdict): void {
  if (verdict.destructive && !result.verdict) result.verdict = verdict;
}

/** Finds the matching parenthesis while respecting the selected quote rules. */
function parenthesized(
  source: string,
  start: number,
  dialect: ShellDialect,
): { body: string; end: number } | undefined {
  let depth = 1;
  let quote: "single" | "double" | null = null;
  let quotedSubstitutionDepth = 0;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "#" && next === ">") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote === "single") {
      if (dialect === "powershell" && char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") quote = null;
      continue;
    }
    const escapeCharacter = dialect === "powershell" ? "`" : "\\";
    if (char === escapeCharacter) {
      index +=
        dialect === "powershell" && next === "\r" && source[index + 2] === "\n"
          ? 2
          : 1;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "$" && next === "(") {
        depth += 1;
        quotedSubstitutionDepth += 1;
        index += 1;
      } else if (char === ")" && quotedSubstitutionDepth > 0) {
        depth -= 1;
        quotedSubstitutionDepth -= 1;
      }
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (char === "#") lineComment = true;
    else if (dialect === "powershell" && char === "<" && next === "#") {
      blockComment = true;
      index += 1;
    } else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(start, index), end: index };
      }
    }
  }
  return undefined;
}

function lex(source: string, dialect: ShellDialect, budget: Budget): Lexed {
  const result: Lexed = { tokens: [] };
  const pendingHeredocs: Array<{
    delimiter: string;
    expand: boolean;
    stripTabs: boolean;
  }> = [];
  let index = 0;
  let boundary = true;
  while (index < source.length && !result.error && !result.verdict) {
    const char = source[index] as string;
    if (char === "\0") {
      result.error = "NUL byte";
      break;
    }
    // A bare carriage return is treated as a command separator in both
    // dialects: real shells differ, but a CR must never hide a later
    // executable segment from classification.
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      addToken(result, budget, { kind: "operator", value: "\n" });
      index += 1;
      boundary = true;
      while (dialect === "posix" && pendingHeredocs.length > 0) {
        const heredoc = pendingHeredocs.shift();
        if (!heredoc) break;
        const bodyStart = index;
        let terminatorStart = -1;
        while (index <= source.length) {
          const lineStart = index;
          let newline = source.indexOf("\n", index);
          let line = source.slice(index, newline < 0 ? source.length : newline);
          // An expanding heredoc folds backslash-newline before comparing
          // against the delimiter, so a folded terminator ends the body here
          // instead of smuggling the following lines into data.
          while (
            heredoc.expand &&
            newline >= 0 &&
            endsWithLineContinuation(line)
          ) {
            const next = source.indexOf("\n", newline + 1);
            line =
              line.slice(0, -1) +
              source.slice(newline + 1, next < 0 ? source.length : next);
            newline = next;
          }
          const comparable = heredoc.stripTabs
            ? line.replace(/^\t+/, "")
            : line;
          if (comparable === heredoc.delimiter) {
            terminatorStart = lineStart;
            index = newline < 0 ? source.length : newline + 1;
            break;
          }
          if (newline < 0) break;
          index = newline + 1;
        }
        if (terminatorStart < 0) {
          result.error = "unterminated heredoc";
          break;
        }
        const body = source.slice(bodyStart, terminatorStart);
        if (heredoc.expand && (body.includes("$(") || body.includes("`"))) {
          result.verdict = unproved("heredoc command interpolation");
          break;
        }
      }
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      boundary = true;
      continue;
    }
    if (char === "#" && boundary) {
      const newline = source.indexOf("\n", index + 1);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (dialect === "powershell" && char === "<" && source[index + 1] === "#") {
      const end = source.indexOf("#>", index + 2);
      if (end < 0) {
        result.error = "unterminated PowerShell block comment";
        break;
      }
      index = end + 2;
      boundary = true;
      continue;
    }
    if (
      dialect === "posix" &&
      (char === "{" || char === "}") &&
      (!boundary || /[^\s;|&(){}]/.test(source[index + 1] ?? ""))
    ) {
      result.error = "brace expansion is not statically supported";
      break;
    }
    const pair = source.slice(index, index + 2);
    // A POSIX arithmetic command's body is data; its `<<` is a shift, not a
    // heredoc. The reading is only accepted when the construct closes with an
    // adjacent `))` and the body holds no quoting, substitution, or statement
    // separator — anything else may make the shell backtrack to executable
    // subshells and must fail closed.
    if (dialect === "posix" && boundary && pair === "((") {
      const span = arithmeticSpan(source, index + 2, "(", ")", 2);
      if (
        !span ||
        source[span.end - 1] !== ")" ||
        !isStaticArithmetic(source.slice(index + 2, span.end - 1))
      ) {
        result.error = "arithmetic command is not statically supported";
        break;
      }
      index = span.end + 1;
      boundary = true;
      continue;
    }
    if (["&&", "||"].includes(pair) || (dialect === "posix" && pair === "|&")) {
      addToken(result, budget, { kind: "operator", value: pair });
      index += 2;
      boundary = true;
      continue;
    }
    const heredocOperator =
      dialect === "posix"
        ? /^(?:\d+)?<<(-)?(?!<)/.exec(source.slice(index))
        : null;
    if (heredocOperator) {
      if (
        !addToken(result, budget, {
          kind: "redirect",
          value: heredocOperator[0],
        })
      ) {
        break;
      }
      index += heredocOperator[0].length;
      while (index < source.length && /[\t ]/.test(source[index] ?? "")) {
        index += 1;
      }
      let delimiter = "";
      let quoted = false;
      let wordStarted = false;
      while (index < source.length) {
        const delimiterChar = source[index] as string;
        if (/\s/.test(delimiterChar) || ";|&(){}<>".includes(delimiterChar)) {
          break;
        }
        if (delimiterChar === "'" || delimiterChar === '"') {
          wordStarted = true;
          quoted = true;
          const quote = delimiterChar;
          index += 1;
          while (index < source.length && source[index] !== quote) {
            delimiter += source[index] as string;
            index += 1;
          }
          if (source[index] !== quote) {
            result.error = "unterminated heredoc delimiter";
            break;
          }
          index += 1;
          continue;
        }
        if (delimiterChar === "\\" && index + 1 < source.length) {
          // Backslash-newline inside the delimiter word is line
          // continuation, not quoting: the folded delimiter still expands
          // its body.
          if (source[index + 1] === "\n") {
            index += 2;
            continue;
          }
          wordStarted = true;
          quoted = true;
          delimiter += source[index + 1] as string;
          index += 2;
          continue;
        }
        wordStarted = true;
        delimiter += delimiterChar;
        index += 1;
      }
      if (result.error) break;
      if (!wordStarted) {
        result.error = "missing heredoc delimiter";
        break;
      }
      if (
        !addToken(result, budget, {
          kind: "word",
          value: delimiter,
          dynamic: false,
          glob: false,
        })
      ) {
        break;
      }
      pendingHeredocs.push({
        delimiter,
        expand: !quoted,
        stripTabs: heredocOperator[1] === "-",
      });
      boundary = false;
      continue;
    }
    if (
      dialect === "posix" &&
      char === "(" &&
      !boundary &&
      /[@?*+!]/.test(source[index - 1] ?? "")
    ) {
      result.error = "extended glob executable is not statically supported";
      break;
    }
    if (dialect === "posix" && pair === "{}") {
      addToken(result, budget, {
        kind: "word",
        value: "{}",
        dynamic: false,
        glob: false,
      });
      index += 2;
      boundary = false;
      continue;
    }
    if (";|&(){}".includes(char)) {
      addToken(result, budget, { kind: "operator", value: char });
      index += 1;
      boundary = true;
      continue;
    }
    if (
      char === ">" ||
      (dialect === "posix" &&
        (char === "<" ||
          (/\d/.test(char) && /[<>]/.test(source[index + 1] ?? ""))))
    ) {
      let value = char;
      index += 1;
      while (/[<>|&]/.test(source[index] ?? "")) {
        value += source[index] as string;
        index += 1;
      }
      addToken(result, budget, { kind: "redirect", value });
      boundary = true;
      continue;
    }

    let value = "";
    let dynamic = false;
    let glob = false;
    let valid = true;
    while (index < source.length) {
      const wordChar = source[index] as string;
      if (dialect === "posix" && wordChar === "{" && value.endsWith("$")) {
        const end = source.indexOf("}", index + 1);
        const parameter = end < 0 ? "" : source.slice(index + 1, end);
        if (end < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
          // A complex expansion is dynamic data when it provably holds no
          // quoting, substitution, or line break; a `<<` inside it is data,
          // never a heredoc. Anything richer stays fail-closed.
          const span = ((): { end: number } | undefined => {
            let depth = 1;
            for (let scan = index + 1; scan < source.length; scan += 1) {
              const braceChar = source[scan] as string;
              if ("'\"`\\\n\r".includes(braceChar)) return undefined;
              if (braceChar === "$" && source[scan + 1] === "(")
                return undefined;
              if (braceChar === "{") depth += 1;
              else if (braceChar === "}") {
                depth -= 1;
                if (depth === 0) return { end: scan };
              }
            }
            return undefined;
          })();
          if (!span) {
            result.error =
              "complex parameter expansion is not statically supported";
            valid = false;
            break;
          }
          value += `{${source.slice(index + 1, span.end)}}`;
          dynamic = true;
          index = span.end + 1;
          continue;
        }
        value += `{${parameter}}`;
        dynamic = true;
        index = end + 1;
        continue;
      }
      // `$((...))` is arithmetic when it closes with an adjacent `))` and the
      // body proves arithmetic-only; otherwise it falls through to the
      // command-substitution reading the shell would back off to.
      if (
        dialect === "posix" &&
        wordChar === "$" &&
        source.slice(index + 1, index + 3) === "(("
      ) {
        const span = arithmeticSpan(source, index + 3, "(", ")", 2);
        if (
          span &&
          source[span.end - 1] === ")" &&
          isStaticArithmetic(source.slice(index + 3, span.end - 1))
        ) {
          value += "__arithmetic__";
          dynamic = true;
          index = span.end + 1;
          continue;
        }
      }
      if (
        dialect === "posix" &&
        wordChar === "$" &&
        source[index + 1] === "["
      ) {
        const span = arithmeticSpan(source, index + 2, "[", "]", 1);
        if (!span || !isStaticArithmetic(source.slice(index + 2, span.end))) {
          result.error =
            "legacy arithmetic expansion is not statically supported";
          valid = false;
          break;
        }
        value += "__arithmetic__";
        dynamic = true;
        index = span.end + 1;
        continue;
      }
      // `name[arithmetic]=value` is an assignment whose subscript is
      // arithmetic context: its `<<` is a shift. Anything unprovable falls
      // through to the ordinary glob reading.
      if (
        dialect === "posix" &&
        wordChar === "[" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
      ) {
        const span = arithmeticSpan(source, index + 1, "[", "]", 1);
        const subscript = span ? source.slice(index + 1, span.end) : "";
        if (
          span &&
          source[span.end + 1] === "=" &&
          !/\s/.test(subscript) &&
          isStaticArithmetic(subscript)
        ) {
          value += `[${subscript}]`;
          dynamic = true;
          index = span.end + 1;
          continue;
        }
      }
      const terminators = dialect === "powershell" ? ";|&(){}>" : ";|&(){}<>";
      if (/\s/.test(wordChar) || terminators.includes(wordChar)) break;
      const escapeCharacter = dialect === "powershell" ? "`" : "\\";
      if (
        dialect === "posix" &&
        wordChar === "$" &&
        (source[index + 1] === "'" || source[index + 1] === '"')
      ) {
        dynamic = true;
        index += 1;
        continue;
      }
      if (wordChar === escapeCharacter) {
        if (index + 1 >= source.length) {
          valid = false;
          break;
        }
        const escaped = source[index + 1] as string;
        if (escaped !== "\n" && escaped !== "\r") value += escaped;
        index +=
          dialect === "powershell" &&
          escaped === "\r" &&
          source[index + 2] === "\n"
            ? 3
            : 2;
        continue;
      }
      if (wordChar === "'") {
        index += 1;
        let closed = false;
        while (index < source.length) {
          if (
            dialect === "powershell" &&
            source[index] === "'" &&
            source[index + 1] === "'"
          ) {
            value += "'";
            index += 2;
          } else if (source[index] === "'") {
            closed = true;
            index += 1;
            break;
          } else {
            value += source[index] as string;
            index += 1;
          }
        }
        if (!closed) valid = false;
        if (!valid) break;
        continue;
      }
      if (wordChar === '"') {
        index += 1;
        let closed = false;
        while (index < source.length) {
          const quoted = source[index] as string;
          const quotedEscape = dialect === "powershell" ? "`" : "\\";
          if (quoted === quotedEscape && index + 1 < source.length) {
            const escaped = source[index + 1] as string;
            if (
              dialect === "powershell" ||
              ["$", "`", '"', "\\", "\n"].includes(escaped)
            ) {
              if (escaped !== "\n") value += escaped;
            } else {
              value += `\\${escaped}`;
            }
            index += 2;
          } else if (quoted === '"') {
            closed = true;
            index += 1;
            break;
          } else if (quoted === "$" && source[index + 1] === "(") {
            const sub = parenthesized(source, index + 2, dialect);
            if (!sub) break;
            recordNested(result, nested(sub.body, dialect, budget));
            dynamic = true;
            value += "__substitution__";
            index = sub.end + 1;
          } else {
            if (quoted === "$" && /[A-Za-z_{]/.test(source[index + 1] ?? "")) {
              dynamic = true;
            }
            value += quoted;
            index += 1;
          }
        }
        if (!closed) valid = false;
        if (!valid || result.verdict) break;
        continue;
      }
      if (wordChar === "$" && source[index + 1] === "(") {
        const sub = parenthesized(source, index + 2, dialect);
        if (!sub) {
          valid = false;
          break;
        }
        recordNested(result, nested(sub.body, dialect, budget));
        dynamic = true;
        value += "__substitution__";
        index = sub.end + 1;
        continue;
      }
      if (dialect === "posix" && wordChar === "`") {
        let end = index + 1;
        while (end < source.length) {
          if (source[end] === "\\") end += 2;
          else if (source[end] === "`") break;
          else end += 1;
        }
        if (end >= source.length) {
          valid = false;
          break;
        }
        recordNested(
          result,
          nested(source.slice(index + 1, end), dialect, budget),
        );
        dynamic = true;
        value += "__substitution__";
        index = end + 1;
        continue;
      }
      if (
        wordChar === "$" &&
        /[A-Za-z_{0-9@*#?$!_-]/.test(source[index + 1] ?? "")
      ) {
        dynamic = true;
      }
      if (dialect === "posix" && /[*?[]/.test(wordChar)) glob = true;
      if (
        dialect === "powershell" &&
        wordChar === "@" &&
        /[A-Za-z_{]/.test(source[index + 1] ?? "")
      ) {
        dynamic = true;
      }
      value += wordChar;
      index += 1;
    }
    if (!valid) {
      result.error ??= `unterminated ${dialect} token`;
      break;
    }
    if (!addToken(result, budget, { kind: "word", value, dynamic, glob }))
      break;
    boundary = false;
  }
  return result;
}

function parseOptions(
  argv: Word[],
  valueOptions: ReadonlySet<string>,
  switchOptions: ReadonlySet<string>,
  assignments = false,
): { index: number } | { error: string } {
  let index = 0;
  while (index < argv.length) {
    const word = argv[index];
    const value = word?.value ?? "";
    if (word?.dynamic) return { error: "dynamic wrapper option" };
    if (value === "--") return { index: index + 1 };
    if (assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    const option = value.split("=", 1)[0] ?? value;
    if (valueOptions.has(option)) {
      if (value.includes("=")) {
        if (value.endsWith("="))
          return { error: `missing value for ${option}` };
        index += 1;
      } else {
        if (!argv[index + 1] || argv[index + 1]?.dynamic) {
          return { error: `missing or dynamic value for ${option}` };
        }
        index += 2;
      }
      continue;
    }
    const attachedValueOption = [...valueOptions]
      .filter((candidate) => /^-[^-]./.test(candidate))
      .find((candidate) => value.startsWith(candidate) && value !== candidate);
    if (attachedValueOption) {
      index += 1;
      continue;
    }
    if (switchOptions.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-") || value.startsWith("+")) {
      return { error: `unsupported wrapper option ${value}` };
    }
    break;
  }
  return { index };
}

function parsedIndex(
  parsed: ReturnType<typeof parseOptions>,
  owner: string,
): number | DestructiveVerdict {
  return "error" in parsed
    ? unproved(`${owner}: ${parsed.error}`)
    : parsed.index;
}

function posixShellCommandFlagIndex(bin: string, argv: Word[]): number {
  const longValueOptions =
    bin === "bash" ? new Set(["--init-file", "--rcfile"]) : new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) return -1;
    if (argument.dynamic) return -2;
    if (argument.value === "--") return -1;
    // These options consume the following word, which must not be mistaken for
    // a command-string flag.
    if (["-o", "+o", "-O", "+O"].includes(argument.value)) {
      index += 1;
      continue;
    }
    const longOption = argument.value.split("=", 1)[0] ?? argument.value;
    if (longValueOptions.has(longOption)) {
      if (!argument.value.includes("=")) index += 1;
      continue;
    }
    if (argument.value === "--command") {
      return index;
    }
    const shortOptions = /^-([A-Za-z]+)$/.exec(argument.value)?.[1];
    if (shortOptions) {
      for (const option of shortOptions) {
        if (option === "c") return index;
        // `o` and Bash's `O` consume the rest of this cluster as their option
        // name, so a later `c` is data rather than command-string mode.
        if (option === "o" || option === "O") break;
      }
      continue;
    }
    if (argument.value.startsWith("-") || argument.value.startsWith("+")) {
      continue;
    }
    return -1;
  }
  return -1;
}

function posixShellReadsStdin(bin: string, argv: Word[]): boolean {
  if (posixShellCommandFlagIndex(bin, argv) >= 0) return false;
  const longValueOptions =
    bin === "bash" ? new Set(["--init-file", "--rcfile"]) : new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument || argument.dynamic) return true;
    if (["-o", "+o", "-O", "+O"].includes(argument.value)) {
      index += 1;
      continue;
    }
    const longOption = argument.value.split("=", 1)[0] ?? argument.value;
    if (longValueOptions.has(longOption)) {
      if (!argument.value.includes("=")) index += 1;
      continue;
    }
    if (argument.value === "--") return index + 1 >= argv.length;
    if (!argument.value.startsWith("-") && !argument.value.startsWith("+")) {
      return false;
    }
  }
  return true;
}

function sqlVerdict(script: string): DestructiveVerdict | undefined {
  const match = DROP_SQL.exec(script);
  return match
    ? {
        destructive: true,
        reason: `drops ${match[1]?.toLowerCase()}`,
        targets: [match[2] ?? ""],
      }
    : undefined;
}

function nestedArgv(
  argv: Word[],
  dialect: ShellDialect,
  budget: Budget,
): DestructiveVerdict {
  if (budget.depth >= MAX_DEPTH) return unproved("nesting limit exceeded");
  return classifyArgv(argv, dialect, { ...budget, depth: budget.depth + 1 });
}

function classifyArgv(
  argv: Word[],
  dialect: ShellDialect,
  budget: Budget,
): DestructiveVerdict {
  let offset = 0;
  while (ASSIGNMENT_WORD.test(argv[offset]?.value ?? "")) offset += 1;
  if (!argv[offset]) return safe();
  if (
    argv[offset]?.dynamic ||
    (argv[offset]?.glob && argv[offset]?.value !== "[")
  ) {
    return unproved("dynamic executable name");
  }
  const bin = binName(argv[offset]?.value ?? "");
  const rest = argv.slice(offset + 1);

  if (dialect === "posix" && POSIX_COMMAND_PREFIXES.has(bin)) {
    return nestedArgv(rest, dialect, budget);
  }
  if (dialect === "posix" && bin === "repeat") {
    if (!rest[0] || rest[0].dynamic) return unproved("dynamic repeat count");
    return nestedArgv(rest.slice(1), dialect, budget);
  }

  if (bin === "env") {
    const split = rest.findIndex((word) =>
      /^(?:-S(?:.|$)|--split-string(?:=|$))/.test(word.value),
    );
    if (split >= 0) {
      const option = rest[split] as Word;
      const inline =
        option.value.startsWith("-S") && option.value !== "-S"
          ? option.value.slice(2)
          : option.value.includes("=")
            ? option.value.slice(option.value.indexOf("=") + 1)
            : undefined;
      const script = inline === undefined ? rest[split + 1] : option;
      const tail = rest.slice(split + (inline === undefined ? 2 : 1));
      if (
        !script ||
        script.dynamic ||
        script.value.includes("\\") ||
        tail.some((word) => word.dynamic)
      ) {
        return unproved("dynamic env split-string program");
      }
      return nested(
        [inline ?? script.value, ...tail.map((word) => word.value)].join(" "),
        "posix",
        budget,
      );
    }
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set([
          "-u",
          "--unset",
          "-C",
          "--chdir",
          "-a",
          "--argv0",
          "-S",
          "--split-string",
        ]),
        new Set([
          "-i",
          "--ignore-environment",
          "-0",
          "--null",
          "-v",
          "--debug",
        ]),
        true,
      ),
      "env options",
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }
  if (bin === "sudo" || bin === "doas") {
    const valued = new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-C",
      "--close-from",
      "-D",
      "--chdir",
      "-R",
      "--chroot",
      "-r",
      "--role",
      "-t",
      "--type",
    ]);
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set([...valued, "-a", "--auth-type", "-T", "--command-timeout"]),
        new Set([
          "-A",
          "--askpass",
          "-b",
          "--background",
          "-E",
          "--preserve-env",
          "-H",
          "--set-home",
          "-i",
          "--login",
          "-n",
          "--non-interactive",
          "-P",
          "--preserve-groups",
          "-S",
          "--stdin",
          "-s",
          "--shell",
        ]),
      ),
      `${bin} options`,
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }
  if (["command", "builtin", "nohup"].includes(bin)) {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(),
        new Set(["-p", "-v", "-V", "-s", "--help", "--version"]),
      ),
      `${bin} options`,
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }
  if (bin === "busybox" || bin === "toybox") {
    return nestedArgv(rest, dialect, budget);
  }
  if (bin === "exec") {
    const parsed = parsedIndex(
      parseOptions(rest, new Set(["-a"]), new Set(["-c", "-l"])),
      "exec options",
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }
  if (bin === "timeout" || bin === "gtimeout") {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(["-k", "--kill-after", "-s", "--signal"]),
        new Set(["--foreground", "--preserve-status", "-v", "--verbose"]),
      ),
      "timeout options",
    );
    if (typeof parsed !== "number") return parsed;
    const optionsEnd = parsed;
    if (rest.slice(0, optionsEnd + 1).some((word) => word.dynamic)) {
      return unproved("dynamic timeout options or duration");
    }
    return nestedArgv(rest.slice(optionsEnd + 1), dialect, budget);
  }
  if (bin === "setsid") {
    const parsed = parsedIndex(
      parseOptions(rest, new Set(), new Set(["-c", "-f", "-w"])),
      "setsid options",
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }
  if (bin === "chrt") {
    if (rest.some((word) => /^(?:-p|--pid)$/.test(word.value))) return safe();
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set([
          "-T",
          "--sched-runtime",
          "-P",
          "--sched-period",
          "-D",
          "--sched-deadline",
        ]),
        new Set(["-b", "-d", "-f", "-i", "-o", "-r", "-R", "-v"]),
      ),
      "chrt options",
    );
    if (typeof parsed !== "number") return parsed;
    const priority = parsed;
    if (rest.slice(0, priority + 1).some((word) => word.dynamic)) {
      return unproved("dynamic chrt options or priority");
    }
    return nestedArgv(rest.slice(priority + 1), dialect, budget);
  }
  if (bin === "ionice") {
    if (
      rest.some((word) => /^(?:-p|-P|-u|--pid|--pgid|--uid)$/.test(word.value))
    ) {
      return safe();
    }
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(["-c", "--class", "-n", "--classdata"]),
        new Set(["-t", "--ignore"]),
      ),
      "ionice options",
    );
    if (typeof parsed !== "number") return parsed;
    const command = parsed;
    if (rest.slice(0, command).some((word) => word.dynamic)) {
      return unproved("dynamic ionice options");
    }
    return nestedArgv(rest.slice(command), dialect, budget);
  }
  if (bin === "unshare") {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set([
          "--map-user",
          "--map-group",
          "--map-users",
          "--map-groups",
          "--propagation",
          "--setgroups",
          "--setuid",
          "--setgid",
          "--monotonic",
          "--boottime",
          "-R",
          "--root",
          "-w",
          "--wd",
        ]),
        new Set([
          "-m",
          "--mount",
          "-u",
          "--uts",
          "-i",
          "--ipc",
          "-n",
          "--net",
          "-p",
          "--pid",
          "-U",
          "--user",
          "-C",
          "--cgroup",
          "-f",
          "--fork",
          "--keep-caps",
        ]),
      ),
      "unshare options",
    );
    if (typeof parsed !== "number") return parsed;
    const command = parsed;
    if (rest.slice(0, command).some((word) => word.dynamic)) {
      return unproved("dynamic unshare options");
    }
    return nestedArgv(rest.slice(command), dialect, budget);
  }
  if (bin === "stdbuf") {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
        new Set(["--help", "--version"]),
      ),
      "stdbuf options",
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }
  if (bin === "chroot") {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(["--userspec", "--groups"]),
        new Set(["--skip-chdir"]),
      ),
      "chroot options",
    );
    if (typeof parsed !== "number") return parsed;
    const root = parsed;
    if (rest.slice(0, root + 1).some((word) => word.dynamic)) {
      return unproved("dynamic chroot options or root");
    }
    return nestedArgv(rest.slice(root + 1), dialect, budget);
  }
  if (bin === "flock") {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set([
          "-E",
          "--conflict-exit-code",
          "-w",
          "--wait",
          "-W",
          "--wait-command",
          "--start",
          "--length",
        ]),
        new Set([
          "-F",
          "--no-fork",
          "-n",
          "--nonblock",
          "-s",
          "--shared",
          "-x",
          "--exclusive",
          "-u",
          "--unlock",
          "--fcntl",
        ]),
      ),
      "flock options",
    );
    if (typeof parsed !== "number") return parsed;
    const lock = parsed;
    if (rest.slice(0, lock + 1).some((word) => word.dynamic)) {
      return unproved("dynamic flock options or lock");
    }
    return nestedArgv(rest.slice(lock + 1), dialect, budget);
  }
  if (bin === "taskset") {
    if (rest.some((word) => /^(?:-p|--pid)$/.test(word.value))) return safe();
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(),
        new Set(["-a", "--all-tasks", "-c", "--cpu-list"]),
      ),
      "taskset options",
    );
    if (typeof parsed !== "number") return parsed;
    const mask = parsed;
    if (rest.slice(0, mask + 1).some((word) => word.dynamic)) {
      return unproved("dynamic taskset options or mask");
    }
    return nestedArgv(rest.slice(mask + 1), dialect, budget);
  }
  if (bin === "runuser") {
    const commandString = rest.findIndex((word) =>
      /^(?:-c|--command)(?:=|$)/.test(word.value),
    );
    if (commandString >= 0) {
      const option = rest[commandString] as Word;
      const inline = option.value.includes("=")
        ? option.value.slice(option.value.indexOf("=") + 1)
        : undefined;
      const program = inline === undefined ? rest[commandString + 1] : option;
      if (!program || program.dynamic) {
        return unproved("dynamic runuser program");
      }
      return nested(inline ?? program.value, "posix", budget);
    }
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set([
          "-u",
          "--user",
          "-g",
          "--group",
          "-G",
          "--supp-group",
          "-s",
          "--shell",
          "-w",
          "--whitelist-environment",
        ]),
        new Set(["-l", "--login", "-P", "--pty"]),
      ),
      "runuser options",
    );
    if (typeof parsed !== "number") return parsed;
    const command = parsed;
    if (rest.slice(0, command).some((word) => word.dynamic)) {
      return unproved("dynamic runuser options");
    }
    return nestedArgv(rest.slice(command), dialect, budget);
  }
  if (bin === "su") {
    const command = rest.findIndex((word) =>
      /^(?:-c|--command)(?:=|$)/.test(word.value),
    );
    if (command >= 0) {
      const option = rest[command] as Word;
      const inline = option.value.includes("=")
        ? option.value.slice(option.value.indexOf("=") + 1)
        : undefined;
      const program = inline === undefined ? rest[command + 1] : option;
      if (!program || program.dynamic) return unproved("dynamic su program");
      return nested(inline ?? program.value, "posix", budget);
    }
    return safe();
  }
  if (bin === "watch") {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(["-n", "--interval"]),
        new Set([
          "-b",
          "--beep",
          "-c",
          "--color",
          "-d",
          "--differences",
          "-e",
          "--errexit",
          "-g",
          "--chgexit",
          "-x",
          "--exec",
        ]),
      ),
      "watch options",
    );
    if (typeof parsed !== "number") return parsed;
    const command = rest.slice(parsed);
    if (!command[0] || command.some((word) => word.dynamic)) {
      return unproved("dynamic watch program");
    }
    return nested(command.map((word) => word.value).join(" "), "posix", budget);
  }
  if (bin === "script") {
    const command = rest.findIndex((word) =>
      /^(?:-c|--command)(?:=|$)/.test(word.value),
    );
    if (command >= 0) {
      const option = rest[command] as Word;
      const inline = option.value.includes("=")
        ? option.value.slice(option.value.indexOf("=") + 1)
        : undefined;
      const program = inline === undefined ? rest[command + 1] : option;
      if (!program || program.dynamic) {
        return unproved("dynamic script command");
      }
      return nested(inline ?? program.value, "posix", budget);
    }
  }
  if (bin === "alias") {
    for (const definition of rest) {
      const equals = definition.value.indexOf("=");
      if (equals < 0) continue;
      if (definition.dynamic) return unproved("dynamic alias definition");
      const verdict = nested(
        definition.value.slice(equals + 1),
        "posix",
        budget,
      );
      if (verdict.destructive) return verdict;
    }
    return safe();
  }
  if (bin === "trap") {
    const program = rest.find((word) => !word.value.startsWith("-"));
    if (!program) return safe();
    if (program.dynamic) return unproved("dynamic trap program");
    return nested(program.value, "posix", budget);
  }
  if (bin === "hash" && rest.some((word) => word.value === "-p")) {
    return unproved("command-name remapping is not statically supported");
  }
  if (dialect === "posix" && (bin === "source" || bin === ".")) {
    return rest.length > 0
      ? unproved("sourced shell program is not statically supported")
      : safe();
  }
  if (
    dialect === "powershell" &&
    ["set-alias", "new-alias", "import-alias"].includes(bin)
  ) {
    return unproved("PowerShell alias mutation is not statically supported");
  }
  if (["time", "nice"].includes(bin)) {
    const parsed = parsedIndex(
      parseOptions(
        rest,
        new Set(["-o", "--output", "-f", "--format", "-n", "--adjustment"]),
        new Set(["-a", "--append", "-p", "--portability", "-v", "--verbose"]),
      ),
      `${bin} options`,
    );
    if (typeof parsed !== "number") return parsed;
    return nestedArgv(rest.slice(parsed), dialect, budget);
  }

  if (POSIX_SHELLS.has(bin) || POWERSHELLS.has(bin) || bin === "cmd") {
    const flag = POSIX_SHELLS.has(bin)
      ? posixShellCommandFlagIndex(bin, rest)
      : rest.findIndex((arg) =>
          bin === "cmd"
            ? /^\/(?:c|k)$/i.test(arg.value)
            : /^-(?:c|co|com|comm|comma|comman|command)$/i.test(arg.value),
        );
    if (flag === -2) return unproved("dynamic nested shell options");
    if (flag >= 0) {
      const program = rest.slice(flag + 1);
      if (!program[0] || program.some((word) => word.dynamic)) {
        return unproved("dynamic nested shell program");
      }
      if (POWERSHELLS.has(bin) && program[0]?.value === "-") {
        return unproved("PowerShell program comes from stdin");
      }
      if (bin === "cmd")
        return unproved("nested cmd program is not statically supported");
      const nestedDialect = POWERSHELLS.has(bin) ? "powershell" : "posix";
      const source = POWERSHELLS.has(bin)
        ? program.map((word) => word.value).join(" ")
        : (program[0]?.value ?? "");
      return nested(source, nestedDialect, budget);
    }
    if (
      POWERSHELLS.has(bin) &&
      rest.some((arg) => /^(?:-file|-commandwithargs)$/i.test(arg.value))
    ) {
      return unproved("PowerShell file program is not statically supported");
    }
    if (
      POWERSHELLS.has(bin) &&
      rest.some((arg) =>
        /^-(?:e|ec|enc|enco|encod|encodedcommand)$/i.test(arg.value),
      )
    ) {
      return unproved("encoded PowerShell program");
    }
    if (!POSIX_SHELLS.has(bin) && rest.some((arg) => arg.dynamic)) {
      return unproved("dynamic nested shell options");
    }
    if (POSIX_SHELLS.has(bin)) {
      const script = rest.find(
        (arg) => !arg.value.startsWith("-") && !arg.value.startsWith("+"),
      );
      if (script) {
        return unproved("shell program comes from a file");
      }
    }
  }

  if (
    dialect === "powershell" &&
    ["start-process", "saps", "start"].includes(bin)
  ) {
    const filePathFlag = /^-(?:f|fi|fil|file|filep|filepa|filepat|filepath)$/i;
    const argumentListFlag =
      /^-(?:a|ar|arg|args|argu|argum|argume|argumen|argument|argumentl|argumentli|argumentlis|argumentlist)$/i;
    const valueOptions = new Set([
      "-credential",
      "-environment",
      "-redirectstandarderror",
      "-redirectstandardinput",
      "-redirectstandardoutput",
      "-verb",
      "-windowstyle",
      "-workingdirectory",
    ]);
    const switches = new Set([
      "-loaduserprofile",
      "-nonewwindow",
      "-passthru",
      "-usenewenvironment",
      "-wait",
    ]);
    const attached = (
      word: Word,
    ): { flag: string; value: string } | undefined => {
      const separator = word.value.indexOf(":");
      if (separator < 0) return undefined;
      return {
        flag: word.value.slice(0, separator),
        value: word.value.slice(separator + 1),
      };
    };
    const opaqueStartValue = (word: Word): boolean =>
      word.dynamic ||
      word.glob ||
      word.value.includes("\n") ||
      word.value.includes("\r") ||
      word.value.startsWith("@") ||
      word.value.startsWith("[");
    let programIndex = -1;
    let attachedProgram: Word | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index];
      if (!word) break;
      const attachedOption = attached(word);
      if (attachedOption && filePathFlag.test(attachedOption.flag)) {
        attachedProgram = {
          kind: "word",
          value: attachedOption.value,
          dynamic: word.dynamic,
          glob: word.glob,
        };
        break;
      }
      if (filePathFlag.test(word.value)) {
        programIndex = index + 1;
        break;
      }
      if (
        attachedOption &&
        valueOptions.has(attachedOption.flag.toLowerCase())
      ) {
        if (!attachedOption.value || opaqueStartValue(word)) {
          return unproved("dynamic Start-Process options");
        }
        continue;
      }
      if (valueOptions.has(word.value.toLowerCase())) {
        if (rest[index + 1]?.dynamic) {
          return unproved("dynamic Start-Process options");
        }
        index += 1;
        continue;
      }
      if (switches.has(word.value.toLowerCase())) continue;
      if (word.value.startsWith("-")) {
        return unproved("opaque Start-Process options");
      }
      programIndex = index;
      break;
    }
    const program = attachedProgram ?? rest[programIndex];
    if (!program || opaqueStartValue(program)) {
      return unproved("dynamic Start-Process file path");
    }
    let argument: Word | undefined;
    let positionalCount = 0;
    for (let index = 0; index < rest.length; index += 1) {
      if (index === programIndex || rest[index] === attachedProgram) continue;
      const word = rest[index];
      if (!word) continue;
      const attachedOption = attached(word);
      if (attachedOption && argumentListFlag.test(attachedOption.flag)) {
        argument = {
          kind: "word",
          value: attachedOption.value,
          dynamic: word.dynamic,
          glob: word.glob,
        };
        continue;
      }
      if (argumentListFlag.test(word.value)) {
        argument = rest[index + 1];
        if (!argument) return unproved("missing Start-Process argument list");
        index += 1;
        continue;
      }
      if (
        filePathFlag.test(word.value) ||
        valueOptions.has(word.value.toLowerCase())
      ) {
        index += 1;
        continue;
      }
      if (switches.has(word.value.toLowerCase())) continue;
      if (word.value.startsWith("-")) {
        return unproved("opaque Start-Process options");
      }
      if (programIndex >= 0 && index === programIndex + 1 && !argument) {
        argument = word;
        positionalCount += 1;
        continue;
      }
      if (index !== programIndex) positionalCount += 1;
    }
    if (
      argument &&
      (opaqueStartValue(argument) ||
        argument.value.includes(",") ||
        argument.value === "@")
    ) {
      return unproved("dynamic or opaque Start-Process argument list");
    }
    if (positionalCount > 1) {
      return unproved("opaque Start-Process positional arguments");
    }
    return nested(
      [program.value, argument?.value].filter(Boolean).join(" "),
      POWERSHELLS.has(binName(program.value)) ? "powershell" : "posix",
      budget,
    );
  }

  if (["eval", "iex", "invoke-expression"].includes(bin)) {
    if (!rest[0] || rest.some((word) => word.dynamic)) {
      return unproved("dynamic evaluator program");
    }
    return nested(
      rest.map((word) => word.value).join(" "),
      bin === "eval" ? "posix" : "powershell",
      budget,
    );
  }

  if (bin === "xargs") {
    const valued = new Set([
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-E",
      "-e",
      "--eof",
      "-I",
      "--replace",
      "-L",
      "--max-lines",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
    ]);
    let replacement: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index]?.value ?? "";
      if (value === "-I" || value === "--replace") {
        replacement = rest[index + 1]?.value;
        if (!replacement || rest[index + 1]?.dynamic) {
          return unproved("dynamic xargs replacement token");
        }
      } else if (value.startsWith("-I") && value !== "-I") {
        replacement = value.slice(2);
      } else if (value.startsWith("--replace=")) {
        replacement = value.slice("--replace=".length);
      }
    }
    const parsed = parsedIndex(
      parseOptions(
        rest,
        valued,
        new Set([
          "-0",
          "--null",
          "-o",
          "--open-tty",
          "-p",
          "--interactive",
          "-r",
          "--no-run-if-empty",
          "-t",
          "--verbose",
          "-x",
          "--exit",
        ]),
      ),
      "xargs options",
    );
    if (typeof parsed !== "number") return parsed;
    const command = rest.slice(parsed);
    const substituted = replacement
      ? command.map((word) => ({
          ...word,
          dynamic: word.dynamic || word.value.includes(replacement),
        }))
      : command;
    return substituted[0] ? nestedArgv(substituted, dialect, budget) : safe();
  }

  if (bin === "rm") {
    const optionBoundary = rest.findIndex((word) => word.value === "--");
    const optionWords =
      optionBoundary < 0 ? rest : rest.slice(0, optionBoundary);
    const targetWords = rest.filter(
      (word, index) =>
        (optionBoundary >= 0 && index > optionBoundary) ||
        (index !== optionBoundary && !word.value.startsWith("-")),
    );
    const recursive = optionWords.some(
      (word) =>
        RECURSIVE_RM_FLAG.test(word.value) ||
        /^--r(?:e(?:c(?:u(?:r(?:s(?:i(?:v(?:e)?)?)?)?)?)?)?)?$/.test(
          word.value,
        ),
    );
    const targets = targetWords.map((word) => word.value);
    if (recursive)
      return { destructive: true, reason: "recursive delete", targets };
    if (dialect === "posix" && optionWords.some((word) => word.dynamic)) {
      return unproved("dynamic rm options");
    }
    const force = optionWords.some(
      (word) =>
        FORCE_RM_FLAG.test(word.value) ||
        /^--f(?:o(?:r(?:c(?:e)?)?)?)?$/.test(word.value),
    );
    if (dialect === "posix" && force && rest.some((word) => word.dynamic)) {
      return unproved("dynamic forced-delete target");
    }
    if (force && targetWords.some((word) => word.glob)) {
      return { destructive: true, reason: "forced glob delete", targets };
    }
  }
  if (
    dialect === "powershell" &&
    PS_REMOVE.has(bin) &&
    rest.some((word) => PS_RECURSE_FLAG.test(word.value))
  ) {
    return {
      destructive: true,
      reason: "recursive delete",
      targets: rest
        .filter((word) => !word.value.startsWith("-"))
        .map((word) => word.value),
    };
  }
  if (dialect === "powershell" && PS_REMOVE.has(bin)) {
    const force = rest.some((word) => PS_FORCE_FLAG.test(word.value));
    const targets = rest.filter((word) => !word.value.startsWith("-"));
    if (force && targets.some((word) => /[*?[]/.test(word.value))) {
      return {
        destructive: true,
        reason: "forced glob delete",
        targets: targets.map((word) => word.value),
      };
    }
    if (force && targets.some((word) => word.dynamic)) {
      return unproved("dynamic forced-delete target");
    }
  }
  if (
    dialect === "powershell" &&
    PS_REMOVE.has(bin) &&
    rest.some((word) => word.dynamic && word.value.startsWith("@"))
  ) {
    return unproved("dynamic PowerShell remove arguments");
  }
  if (bin === "find") {
    if (rest.some((word) => word.dynamic)) {
      return unproved("dynamic find expression");
    }
    if (rest.some((word) => word.value === "-delete")) {
      return {
        destructive: true,
        reason: "bulk find-delete",
        targets: rest
          .filter((word) => !word.value.startsWith("-"))
          .slice(0, 3)
          .map((word) => word.value),
      };
    }
    const start = rest.findIndex((word) =>
      ["-exec", "-execdir", "-ok", "-okdir"].includes(word.value),
    );
    if (start >= 0) {
      const finish = rest.findIndex(
        (word, index) => index > start && [";", "+"].includes(word.value),
      );
      const verdict = nestedArgv(
        rest.slice(start + 1, finish < 0 ? undefined : finish).map((word) => ({
          ...word,
          dynamic: word.dynamic || word.value === "{}",
        })),
        "posix",
        budget,
      );
      if (verdict.destructive) return verdict;
    }
  }
  if (bin === "dd") {
    const output = rest.find((word) => /^of=\/dev\//.test(word.value));
    if (output) {
      return {
        destructive: true,
        reason: "raw device overwrite",
        targets: [output.value],
      };
    }
    if (rest.some((word) => word.dynamic && /^of=/.test(word.value))) {
      return unproved("dynamic dd output");
    }
  }
  if (DESTRUCTIVE_BINS.has(bin) || bin.startsWith("mkfs.")) {
    return {
      destructive: true,
      reason: `${bin} destroys its target`,
      targets: rest
        .filter((word) => !word.value.startsWith("-"))
        .map((word) => word.value),
    };
  }
  if (SQL_RUNNERS.has(bin)) {
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index]?.value ?? "";
      const inline = /^(?:-c|-e|--command=|--execute=)(.+)$/s.exec(
        argument,
      )?.[1];
      const separate = /^(?:-c|-e|--command|--execute)$/.test(argument)
        ? rest[index + 1]
        : undefined;
      if (separate?.dynamic || (rest[index]?.dynamic && inline !== undefined)) {
        return unproved("dynamic SQL program");
      }
      const verdict = sqlVerdict(inline ?? separate?.value ?? "");
      if (verdict) return verdict;
    }
    if (rest.some((word) => /^(?:-f|--file)(?:=|$)/.test(word.value))) {
      return unproved("SQL program comes from a file");
    }
  }
  if (bin === "invoke-sqlcmd") {
    const query = rest.findIndex((word) => /^-(?:q|query)$/i.test(word.value));
    if (query >= 0 && rest[query + 1]?.dynamic) {
      return unproved("dynamic SQL program");
    }
    const verdict = sqlVerdict(
      query >= 0 ? (rest[query + 1]?.value ?? "") : "",
    );
    if (verdict) return verdict;
  }
  return safe();
}

function classifyTokens(
  tokens: Token[],
  dialect: ShellDialect,
  budget: Budget,
): DestructiveVerdict {
  let command: Word[] = [];
  let redirectTarget = false;
  let inputProgramRedirect = false;
  let callTarget = false;
  let pipedSql: DestructiveVerdict | undefined;
  let pipedInput = false;
  const flush = (): DestructiveVerdict => {
    const executableIndex = command.findIndex(
      (word) => !ASSIGNMENT_WORD.test(word.value),
    );
    const executable = binName(command[executableIndex]?.value ?? "");
    const executableRest = command.slice(executableIndex + 1);
    const verdict =
      pipedSql &&
      (SQL_RUNNERS.has(executable) || executable === "invoke-sqlcmd")
        ? pipedSql
        : (pipedInput || inputProgramRedirect) && SQL_RUNNERS.has(executable)
          ? unproved("SQL program comes from stdin")
          : inputProgramRedirect &&
              (executable === "source" || executable === ".")
            ? unproved("sourced shell program comes from redirected input")
            : (pipedInput || inputProgramRedirect) &&
                POSIX_SHELLS.has(executable) &&
                posixShellReadsStdin(executable, executableRest)
              ? unproved("nested shell program comes from stdin")
              : classifyArgv(command, dialect, budget);
    command = [];
    inputProgramRedirect = false;
    return verdict;
  };
  for (const token of tokens) {
    if (token.kind === "redirect") {
      if (token.value.includes("<")) inputProgramRedirect = true;
      redirectTarget = true;
      continue;
    }
    if (token.kind === "operator") {
      if (
        dialect === "powershell" &&
        token.value === "&" &&
        command.length === 0
      ) {
        callTarget = true;
        continue;
      }
      if (callTarget) return unproved("computed PowerShell call target");
      const outboundSql = sqlVerdict(
        command
          .slice(1)
          .map((word) => word.value)
          .join(" "),
      );
      const verdict = flush();
      if (verdict.destructive) return verdict;
      pipedSql = token.value === "|" ? (pipedSql ?? outboundSql) : undefined;
      pipedInput = token.value === "|";
      redirectTarget = false;
      continue;
    }
    if (redirectTarget) {
      redirectTarget = false;
      continue;
    }
    if (token.kind !== "word") continue;
    command.push(token);
    callTarget = false;
  }
  if (callTarget) return unproved("missing PowerShell call target");
  return flush();
}

function scan(
  source: string,
  dialect: ShellDialect,
  budget: Budget,
): DestructiveVerdict {
  if (source.length > MAX_CHARS)
    return unproved("source length limit exceeded");
  const result = lex(source, dialect, budget);
  if (result.verdict) return result.verdict;
  if (result.error) return unproved(result.error);
  return classifyTokens(result.tokens, dialect, budget);
}

/** Classifies with the dialect of the shell that will actually execute it. */
export function classifyDestructiveCommand(
  command: string,
  dialect: ShellDialect = "posix",
): DestructiveVerdict {
  return scan(command, dialect, { depth: 0, tokens: 0 });
}
