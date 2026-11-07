// HTML maps &#128;-&#159; through windows-1252 (WHATWG numeric character
// reference table); the five unassigned slots stay C1 and are left as written.
const WINDOWS_1252_C1 =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

/** Decodes the common named entities and in-range numeric references. */
export function decodeBasicHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(nbsp|amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi,
    (entity, name: string) => {
      const key = name.toLowerCase();
      const named = namedEntities[key];
      if (named !== undefined) return named;
      // React writes apostrophes as &#x27;; WordPress writes &#8217; and &#8211;.
      const hex = /^#x([0-9a-f]+)$/.exec(key);
      const code = Number.parseInt(hex ? hex[1] : key.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff)
        return entity;
      if (code >= 0xd800 && code <= 0xdfff) return entity;
      if (code === 0xa0) return " ";
      if (code >= 0x80 && code <= 0x9f) {
        const mapped = WINDOWS_1252_C1[code - 0x80];
        return mapped.charCodeAt(0) === code ? entity : mapped;
      }
      return String.fromCodePoint(code);
    },
  );
}
