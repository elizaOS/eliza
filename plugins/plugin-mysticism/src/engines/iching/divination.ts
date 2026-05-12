import type { CastResult, Hexagram, Trigram } from "../../types.js";
import hexagramsData from "./data/hexagrams.json" with { type: "json" };
import trigramsData from "./data/trigrams.json" with { type: "json" };

const trigrams: Trigram[] = trigramsData as Trigram[];
const hexagrams: Hexagram[] = hexagramsData as Hexagram[];

const trigramByNumber = new Map<number, Trigram>(trigrams.map((t) => [t.number, t]));

const hexagramByNumber = new Map<number, Hexagram>(hexagrams.map((h) => [h.number, h]));

const binaryToNumber = new Map<string, number>(hexagrams.map((h) => [h.binary, h.number]));

function flipCoin(): boolean {
  const array = new Uint8Array(1);
  crypto.getRandomValues(array);
  return array[0] >= 128;
}

/**
 * Line values in the I Ching three-coin method:
 *
 * - 6 = Old Yin   (broken ⚋, changing → solid ⚊)
 * - 7 = Young Yang (solid ⚊, stable)
 * - 8 = Young Yin  (broken ⚋, stable)
 * - 9 = Old Yang   (solid ⚊, changing → broken ⚋)
 */
interface CastLineResult {
  /** Raw coin sum: 6, 7, 8, or 9 */
  value: number;
  /** Whether this line is a changing line */
  changing: boolean;
}

/**
 * Three coins are tossed. Heads = 3, Tails = 2.
 * The sum determines the line type:
 * - 6 (2+2+2) = Old Yin   → changing broken line
 * - 7 (2+2+3) = Young Yang → stable solid line
 * - 8 (2+3+3) = Young Yin  → stable broken line
 * - 9 (3+3+3) = Old Yang   → changing solid line
 */
function castLine(): CastLineResult {
  const coin1 = flipCoin() ? 3 : 2;
  const coin2 = flipCoin() ? 3 : 2;
  const coin3 = flipCoin() ? 3 : 2;
  const value = coin1 + coin2 + coin3;

  return {
    value,
    changing: value === 6 || value === 9,
  };
}

function lineValueToBinary(value: number): number {
  // 7 and 9 are yang (solid) → 1
  // 6 and 8 are yin (broken) → 0
  return value === 7 || value === 9 ? 1 : 0;
}

function lineValueToTransformedBinary(value: number): number {
  if (value === 6) return 1; // Old Yin → Yang
  if (value === 9) return 0; // Old Yang → Yin
  return lineValueToBinary(value); // Young lines stay
}

/** Lines are cast from bottom (position 1) to top (position 6). */
export function castHexagram(): CastResult {
  const castLines: CastLineResult[] = [];
  for (let i = 0; i < 6; i++) {
    castLines.push(castLine());
  }

  const lines = castLines.map((cl) => cl.value);
  const changingLines = castLines
    .map((cl, i) => (cl.changing ? i + 1 : -1))
    .filter((pos) => pos !== -1);

  // Build binary string (bottom to top = left to right)
  const binary = castLines.map((cl) => lineValueToBinary(cl.value)).join("");
  const hexagramNumber = binaryToHexagramNumber(binary);

  let transformedHexagramNumber: number | null = null;
  let transformedBinary: string | null = null;

  if (changingLines.length > 0) {
    transformedBinary = castLines.map((cl) => lineValueToTransformedBinary(cl.value)).join("");
    transformedHexagramNumber = binaryToHexagramNumber(transformedBinary);
  }

  return {
    lines,
    changingLines,
    hexagramNumber,
    transformedHexagramNumber,
    binary,
    transformedBinary,
  };
}

/**
 * Binary format: positions 1-6 (bottom to top) as "0" (yin) or "1" (yang).
 * Example: "111111" → Hexagram 1 (Qian / The Creative)
 */
export function binaryToHexagramNumber(binary: string): number {
  const number = binaryToNumber.get(binary);
  if (number === undefined) {
    throw new Error(`Unknown hexagram binary pattern: ${binary}`);
  }
  return number;
}

export function getHexagram(number: number): Hexagram {
  const hexagram = hexagramByNumber.get(number);
  if (!hexagram) {
    throw new Error(`Hexagram number ${number} not found (valid range: 1-64)`);
  }
  return hexagram;
}

export function getTrigram(number: number): Trigram {
  const trigram = trigramByNumber.get(number);
  if (!trigram) {
    throw new Error(`Trigram number ${number} not found (valid range: 1-8)`);
  }
  return trigram;
}

export function getLowerTrigram(hexagram: Hexagram): Trigram {
  return getTrigram(hexagram.bottomTrigram);
}

export function getUpperTrigram(hexagram: Hexagram): Trigram {
  return getTrigram(hexagram.topTrigram);
}
