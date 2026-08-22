/**
 * X/Twitter weighted tweet length (twitter-text v3): Latin-range code points
 * count as 1, CJK and other default-weight code points as 2, and http(s) URLs
 * as 23. Used by the connector post gate and the generated-post / thread
 * splitters so a string that JavaScript `.length` calls "short" is not sent
 * when X would reject it.
 */

export const TWEET_WEIGHTED_SCALE = 100;
export const TWEET_DEFAULT_WEIGHT = 200;
export const TWEET_TRANSFORMED_URL_LENGTH = 23;

const WEIGHT_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 4351, 100],
  [8192, 8205, 100],
  [8208, 8223, 100],
  [8242, 8247, 100],
];

const URL_RE = /https?:\/\/[^\s]+/i;

function codePointWeight(codePoint: number): number {
  for (const [start, end, weight] of WEIGHT_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return weight;
    }
  }
  return TWEET_DEFAULT_WEIGHT;
}

function nextUrlAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  const match = text.slice(index).match(URL_RE);
  if (match?.index !== 0) return undefined;
  return match[0];
}

function unitWeight(codePoint: number): number {
  return codePointWeight(codePoint) / TWEET_WEIGHTED_SCALE;
}

/**
 * Weighted length used by X for the 280-unit tweet cap (twitter-text v3).
 */
export function countTwitterWeightedLength(text: string): number {
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const url = nextUrlAt(text, index);
    if (url) {
      used += TWEET_TRANSFORMED_URL_LENGTH;
      index += url.length;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    used += unitWeight(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return Math.floor(used);
}

/**
 * Longest prefix of `text` whose weighted length is <= `maxLength`.
 * Walks Unicode code points so a supplementary-plane character is never split.
 */
export function truncateToTwitterWeightedLength(
  text: string,
  maxLength: number,
): string {
  if (maxLength <= 0) return "";
  if (countTwitterWeightedLength(text) <= maxLength) return text;

  let used = 0;
  let index = 0;
  while (index < text.length) {
    const url = nextUrlAt(text, index);
    if (url) {
      if (used + TWEET_TRANSFORMED_URL_LENGTH > maxLength) break;
      used += TWEET_TRANSFORMED_URL_LENGTH;
      index += url.length;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const weight = unitWeight(codePoint);
    if (used + weight > maxLength) break;
    used += weight;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return text.slice(0, index);
}
