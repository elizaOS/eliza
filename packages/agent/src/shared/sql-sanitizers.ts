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
