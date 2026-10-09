/** Explicit URL tokens only. OCR never executes or silently repairs a destination. */
export function scannedLinks(text: string): string[] {
  if (typeof text !== "string" || text.length > 100000) return [];
  const result: string[] = [];
  for (const match of text.matchAll(
    /(?:^|[\s([{"'])((?:https?:\/\/|www\.)[^\s<>"'`]+)/gi,
  )) {
    let raw = match[1].replace(/[.,;]+$/, "");
    for (const [close, open] of [
      [")", "("],
      ["]", "["],
      ["}", "{"],
    ]) {
      while (
        raw.endsWith(close) &&
        raw.split(close).length > raw.split(open).length
      )
        raw = raw.slice(0, -1);
    }
    if (
      /^https?:\/\/[/?#]/i.test(raw) ||
      raw.length > 2048 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted input.
      /[\\\u0000-\u001f\u007f]/.test(raw)
    )
      continue;
    try {
      const url = new URL(/^www\./i.test(raw) ? "https://" + raw : raw);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        continue;
      if (!result.includes(url.href)) result.push(url.href);
      if (result.length === 10) break;
    } catch {
      /* Invalid OCR is kept in the editable text, never navigated. */
    }
  }
  return result;
}
