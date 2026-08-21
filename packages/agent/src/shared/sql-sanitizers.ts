/**
 * Linear SQL text sanitizers used before read-only guard scans. These helpers
 * intentionally preserve malformed/unterminated constructs so invalid SQL does
 * not hide mutation keywords from the caller's policy check.
 */

/**
 * Strip non-nested C-style block comments (opened with slash-star, closed with
 * star-slash) from SQL in a single linear pass. Used instead of the obvious
 * `/\/\*[\s\S]*?\*\//g` regex because that regex's global re-scan is O(n²) on
 * adversarial input.
 */
export function stripSqlBlockComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    const open = sql.indexOf("/*", i);
    if (open === -1) {
      result += sql.slice(i);
      break;
    }
    const close = sql.indexOf("*/", open + 2);
    if (close === -1) {
      result += sql.slice(i);
      break;
    }
    result += sql.slice(i, open);
    i = close + 2;
  }
  return result;
}

function sqlLineTerminatorLength(sql: string, index: number): number {
  const char = sql.charCodeAt(index);
  if (char === 0x0a || char === 0x2028 || char === 0x2029) return 1;
  if (char === 0x0d) return sql.charCodeAt(index + 1) === 0x0a ? 2 : 1;
  return 0;
}

/** Strip double-dash comments through the next line ending in one forward pass. */
export function stripSqlLineComments(sql: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const open = sql.indexOf("--", cursor);
    if (open < 0) {
      chunks.push(sql.slice(cursor));
      break;
    }
    chunks.push(sql.slice(cursor, open));
    let terminator = open + 2;
    let terminatorLength = 0;
    while (terminator < sql.length) {
      terminatorLength = sqlLineTerminatorLength(sql, terminator);
      if (terminatorLength > 0) break;
      terminator += 1;
    }
    if (terminatorLength === 0) break;
    chunks.push(sql.slice(terminator, terminator + terminatorLength));
    cursor = terminator + terminatorLength;
  }
  return chunks.join("");
}

/**
 * Strip PostgreSQL dollar-quoted literals (`$$...$$`, `$tag$...$tag$`) in a
 * single pass. Unterminated literals are left intact so the read-only guard
 * still sees any mutation text that follows invalid SQL.
 */
export function stripSqlDollarQuotedLiterals(sql: string): string {
  let result = "";
  let i = 0;

  while (i < sql.length) {
    if (sql[i] !== "$") {
      result += sql[i];
      i += 1;
      continue;
    }

    let tagEnd = i + 1;
    while (
      tagEnd < sql.length &&
      /[A-Za-z0-9_]/.test(sql.charAt(tagEnd)) &&
      tagEnd - i <= 128
    ) {
      tagEnd += 1;
    }

    if (tagEnd >= sql.length || sql[tagEnd] !== "$") {
      result += sql[i];
      i += 1;
      continue;
    }

    const delimiter = sql.slice(i, tagEnd + 1);
    let j = tagEnd + 1;
    let closedAt = -1;
    while (j < sql.length) {
      if (sql.startsWith(delimiter, j)) {
        closedAt = j;
        break;
      }
      j += 1;
    }

    if (closedAt === -1) {
      result += sql.slice(i);
      break;
    }

    result += " ";
    i = closedAt + delimiter.length;
  }

  return result;
}

const MAX_DOLLAR_QUOTE_TAG_LENGTH = 128;
export const MAX_READ_ONLY_SQL_LENGTH = 2 * 1024 * 1024;

export type ReadOnlySqlScan =
  | {
      ok: true;
      keywordText: string;
      callableText: string;
      structuralText: string;
    }
  | { ok: false; reason: string };

function isAsciiIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isAsciiIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

/**
 * Tokenize the SQL contexts relevant to the read-only policy in one bounded
 * pass. Malformed constructs are rejected instead of being preserved for a
 * later regex, where context ordering can hide executable text.
 */
export function scanSqlForReadOnly(sql: string): ReadOnlySqlScan {
  if (sql.length > MAX_READ_ONLY_SQL_LENGTH) {
    return {
      ok: false,
      reason: `Read-only SQL is limited to ${MAX_READ_ONLY_SQL_LENGTH} characters.`,
    };
  }

  let keywordText = "";
  let callableText = "";
  let structuralText = "";
  let i = 0;

  const appendOutside = (text: string): void => {
    keywordText += text;
    callableText += text;
    structuralText += text;
  };

  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      i += 2;
      while (i < sql.length && sqlLineTerminatorLength(sql, i) === 0) i += 1;
      appendOutside(" ");
      continue;
    }

    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth !== 0) {
        return { ok: false, reason: "Unterminated block comment." };
      }
      // Empty replacement deliberately makes split policy keywords visible.
      continue;
    }

    if (sql[i] === "$") {
      if (isAsciiIdentifierPart(sql[i - 1])) {
        appendOutside("$");
        i += 1;
        continue;
      }
      let tagEnd = i + 1;
      if (sql[tagEnd] !== "$" && !isAsciiIdentifierStart(sql[tagEnd])) {
        appendOutside("$");
        i += 1;
        continue;
      }
      while (
        tagEnd < sql.length &&
        sql[tagEnd] !== "$" &&
        isAsciiIdentifierPart(sql[tagEnd])
      ) {
        if (tagEnd - i > MAX_DOLLAR_QUOTE_TAG_LENGTH) {
          return {
            ok: false,
            reason: `Dollar-quote tags longer than ${MAX_DOLLAR_QUOTE_TAG_LENGTH} characters are not allowed in read-only mode.`,
          };
        }
        tagEnd += 1;
      }
      if (sql[tagEnd] !== "$") {
        appendOutside("$");
        i += 1;
        continue;
      }

      const delimiter = sql.slice(i, tagEnd + 1);
      let close = tagEnd + 1;
      while (close < sql.length && !sql.startsWith(delimiter, close))
        close += 1;
      if (close >= sql.length) {
        return { ok: false, reason: "Unterminated dollar-quoted string." };
      }
      appendOutside(" ");
      i = close + delimiter.length;
      continue;
    }

    if (sql[i] === "'") {
      const escapePrefix =
        i > 0 &&
        (sql[i - 1] === "e" || sql[i - 1] === "E") &&
        !isAsciiIdentifierPart(sql[i - 2]);
      if (escapePrefix) {
        keywordText = keywordText.slice(0, -1);
        callableText = callableText.slice(0, -1);
        structuralText = structuralText.slice(0, -1);
      }

      let closed = false;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          closed = true;
          break;
        } else if (sql[i] === "\\" && escapePrefix) {
          i += Math.min(2, sql.length - i);
        } else {
          i += 1;
        }
      }
      if (!closed) return { ok: false, reason: "Unterminated string literal." };
      appendOutside(" ");
      continue;
    }

    if (sql[i] === '"') {
      const unicodePrefix =
        i >= 2 &&
        (sql[i - 2] === "u" || sql[i - 2] === "U") &&
        sql[i - 1] === "&" &&
        !isAsciiIdentifierPart(sql[i - 3]);
      if (unicodePrefix) {
        return {
          ok: false,
          reason:
            'Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
        };
      }

      let decoded = "";
      let closed = false;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          decoded += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i += 1;
          closed = true;
          break;
        } else {
          decoded += sql[i];
          i += 1;
        }
      }
      if (!closed)
        return { ok: false, reason: "Unterminated quoted identifier." };
      keywordText += " ";
      callableText += decoded;
      structuralText += " ";
      continue;
    }

    appendOutside(sql[i]);
    i += 1;
  }

  return { ok: true, keywordText, callableText, structuralText };
}
