import punycode from "punycode/punycode.js";
import { parse } from "tldts";

const { toUnicode } = punycode;
const options = { allowPrivateDomains: true };
// Common Greek/Cyrillic/Latin visual substitutions. This is a suspicion signal,
// not a complete Unicode security implementation or a safety verdict.
const confusables = {
  а: "a",
  ɑ: "a",
  α: "a",
  е: "e",
  ε: "e",
  о: "o",
  ο: "o",
  р: "p",
  ρ: "p",
  с: "c",
  ϲ: "c",
  х: "x",
  χ: "x",
  у: "y",
  ү: "y",
  і: "i",
  ι: "i",
  ӏ: "l",
  ⅼ: "l",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ɡ: "g",
  ԛ: "q",
  ν: "v",
  κ: "k",
  м: "m",
  т: "t",
  в: "b",
};
const skeleton = (value) =>
  toUnicode(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{Mark}/gu, "")
    .replace(/[\s\S]/gu, (c) => confusables[c] ?? c);
function oneEdit(a, b) {
  if (a === b) return false;
  if (a.length === b.length) {
    const changed = [...a]
      .map((c, i) => (c === b[i] ? -1 : i))
      .filter((i) => i >= 0);
    if (changed.length === 2) {
      const [i, j] = changed;
      if (j === i + 1 && a[i] === b[j] && a[j] === b[i]) return true;
    }
  }
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0,
    j = 0,
    n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++n > 1) return false;
    if (a.length <= b.length) j++;
    if (a.length >= b.length) i++;
  }
  return n + (a.length - i) + (b.length - j) === 1;
}
/** Local suspicion signal, not a safety verdict. Reference roots are host policy.
 * @param {string} address
 * @param {readonly string[]} knownSites Reviewed ASCII registrable reference domains.
 * @returns {{status:'lookalike',suggested:string,reason:'similar-domain'}|null}
 */
export function detectDomainLookalike(address, knownSites) {
  const host = new URL(address).hostname.toLowerCase().replace(/\.$/, "");
  const parsed = parse(host, options),
    domain = parsed.domain;
  if (!domain || knownSites.includes(domain)) return null;
  const normalized = skeleton(domain),
    brand = skeleton(parsed.domainWithoutSuffix ?? "");
  const match = knownSites.find((site) => {
    const official = parse(site, options),
      label = official.domainWithoutSuffix ?? "";
    return (
      `.${host}.`.includes(`.${site}.`) ||
      normalized === site ||
      (label.length >= 5 && (brand === label || oneEdit(brand, label)))
    );
  });
  return match
    ? {
        status: "lookalike",
        suggested: `https://${match}/`,
        reason: "similar-domain",
      }
    : null;
}
