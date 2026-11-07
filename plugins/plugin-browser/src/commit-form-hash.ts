/**
 * The form contents a consented commit is bound to (`NativeCommitGrant.formHash`).
 *
 * Lowercase hex SHA-256 of `"eliza-commit-form-v1\n"` followed by the JSON
 * array of `[name, value]` string pairs, in the order the form sends them
 * (tree order, the submitter's own name/value included where it sits), with:
 * - entries whose value is not a string (file inputs) left out;
 * - every name and value with CRLF and lone CR turned into LF, then
 *   Unicode NFC normalized.
 *
 * The page computes the same digest from the actual FormData of the submit
 * (page-command.mjs carries a copy of this function, since it runs as source
 * text in the page; the browser tests check that both agree). Synchronous and
 * dependency-free, so it runs in any host and in a page without WebCrypto.
 */
export function commitFormHash(
  entries: Iterable<readonly [string, unknown]>,
): string {
  const pairs: Array<[string, string]> = [];
  const normal = (text: string) =>
    text.replace(/\r\n?/g, "\n").normalize("NFC");
  for (const [name, value] of entries)
    if (typeof value === "string") pairs.push([normal(name), normal(value)]);
  const bytes = new TextEncoder().encode(
    `eliza-commit-form-v1\n${JSON.stringify(pairs)}`,
  );
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const padded = new Uint8Array(((bytes.length + 72) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++)
      w[i] =
        w[i - 16] +
        (rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3)) +
        w[i - 7] +
        (rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10));
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          k[i] +
          w[i]) |
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      hash[i] = (hash[i] + value) | 0;
    });
  }
  return hash
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
