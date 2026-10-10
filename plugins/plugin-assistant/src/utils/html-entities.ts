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
      return String.fromCodePoint(code);
    },
  );
}
