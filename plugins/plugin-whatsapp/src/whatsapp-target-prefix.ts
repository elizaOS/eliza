/**
 * Linear strip of repeated `whatsapp:` URI prefixes on inbound targets.
 * The previous loop copied the whole remainder on every peel
 * (`replace(/^whatsapp:/i) + trim`), so a megabyte of repeated prefixes was
 * quadratic and hung JID/phone normalization on the ingest path. Honest
 * handles have zero or one prefix.
 */

const PREFIX = "whatsapp:";

function isAsciiSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Strip every leading `whatsapp:` (case-insensitive) plus surrounding ASCII space. */
export function stripWhatsAppTargetPrefixes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiSpace(value.charCodeAt(start))) start += 1;
  while (end > start && isAsciiSpace(value.charCodeAt(end - 1))) end -= 1;

  while (start + PREFIX.length <= end) {
    let matches = true;
    for (let i = 0; i < PREFIX.length; i += 1) {
      const code = value.charCodeAt(start + i);
      const expect = PREFIX.charCodeAt(i);
      const folded =
        expect >= 97 && expect <= 122
          ? code === expect || code === expect - 32
          : code === expect;
      if (!folded) {
        matches = false;
        break;
      }
    }
    if (!matches) break;
    start += PREFIX.length;
    while (start < end && isAsciiSpace(value.charCodeAt(start))) start += 1;
  }

  while (end > start && isAsciiSpace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}
