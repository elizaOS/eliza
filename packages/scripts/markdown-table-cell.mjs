/** Encodes untrusted Markdown-table cell text in one bounded, order-sensitive pass pipeline. */

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

/**
 * Escape Markdown cell syntax and collapse every JavaScript/Unicode line break.
 * Backslashes must be escaped before pipes so input cannot consume the pipe escape.
 */
export function encodeMarkdownTableCell(value, lineBreak = " ") {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(LINE_BREAKS, lineBreak);
}
