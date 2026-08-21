/**
 * Linear strip of repeated `whatsapp:` URI prefixes on inbound targets.
 * The previous loop copied the whole remainder on every peel
 * (`replace(/^whatsapp:/i) + trim`), so a megabyte of repeated prefixes was
 * quadratic and hung JID/phone normalization on the ingest path. Honest
 * handles have zero or one prefix.
 */

const PREFIX = "whatsapp:";

function isEcmaTrimWhitespace(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Strip every leading `whatsapp:` while preserving `String.trim()` compatibility. */
export function stripWhatsAppTargetPrefixes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isEcmaTrimWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isEcmaTrimWhitespace(value.charCodeAt(end - 1))) end -= 1;

  while (start + PREFIX.length <= end) {
    let matches = true;
    for (let i = 0; i < PREFIX.length; i += 1) {
      const code = value.charCodeAt(start + i);
      const expect = PREFIX.charCodeAt(i);
      const folded =
        expect >= 97 && expect <= 122 ? code === expect || code === expect - 32 : code === expect;
      if (!folded) {
        matches = false;
        break;
      }
    }
    if (!matches) break;
    start += PREFIX.length;
    while (start < end && isEcmaTrimWhitespace(value.charCodeAt(start))) start += 1;
  }

  while (end > start && isEcmaTrimWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}
