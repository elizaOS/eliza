import { tool } from "ai";
import { z } from "zod";

/**
 * Typewriter benchmark tools that create one tool for each letter of the alphabet.
 * Used for testing and benchmarking tool selection and usage patterns.
 */

type TypewriterLetter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

/**
 * Creates a typewriter tool for a specific letter
 */
function createLetterTool(letter: TypewriterLetter) {
  return tool({
    description: `Types the letter '${letter.toUpperCase()}' on the typewriter`,
    inputSchema: z.object({
      uppercase: z
        .boolean()
        .default(false)
        .describe("Whether to type the letter in uppercase"),
      repeat: z
        .number()
        .min(1)
        .max(10)
        .default(1)
        .describe("Number of times to type the letter"),
    }),
    execute: async ({ uppercase, repeat }) => {
      const char = uppercase ? letter.toUpperCase() : letter;
      const output = char.repeat(repeat);
      
      return {
        success: true,
        letter,
        output,
        uppercase,
        repeat,
        timestamp: new Date().toISOString(),
        message: `Typed '${output}' on the typewriter`,
      };
    },
  });
}

// Generate all 26 typewriter tools
export const typewriterA = createLetterTool("a");
export const typewriterB = createLetterTool("b");
export const typewriterC = createLetterTool("c");
export const typewriterD = createLetterTool("d");
export const typewriterE = createLetterTool("e");
export const typewriterF = createLetterTool("f");
export const typewriterG = createLetterTool("g");
export const typewriterH = createLetterTool("h");
export const typewriterI = createLetterTool("i");
export const typewriterJ = createLetterTool("j");
export const typewriterK = createLetterTool("k");
export const typewriterL = createLetterTool("l");
export const typewriterM = createLetterTool("m");
export const typewriterN = createLetterTool("n");
export const typewriterO = createLetterTool("o");
export const typewriterP = createLetterTool("p");
export const typewriterQ = createLetterTool("q");
export const typewriterR = createLetterTool("r");
export const typewriterS = createLetterTool("s");
export const typewriterT = createLetterTool("t");
export const typewriterU = createLetterTool("u");
export const typewriterV = createLetterTool("v");
export const typewriterW = createLetterTool("w");
export const typewriterX = createLetterTool("x");
export const typewriterY = createLetterTool("y");
export const typewriterZ = createLetterTool("z");

// Export all tools as an array for convenience
export const allTypewriterTools = [
  typewriterA, typewriterB, typewriterC, typewriterD, typewriterE,
  typewriterF, typewriterG, typewriterH, typewriterI, typewriterJ,
  typewriterK, typewriterL, typewriterM, typewriterN, typewriterO,
  typewriterP, typewriterQ, typewriterR, typewriterS, typewriterT,
  typewriterU, typewriterV, typewriterW, typewriterX, typewriterY,
  typewriterZ,
];

// Export a map for programmatic access
export const typewriterToolMap = {
  a: typewriterA, b: typewriterB, c: typewriterC, d: typewriterD, e: typewriterE,
  f: typewriterF, g: typewriterG, h: typewriterH, i: typewriterI, j: typewriterJ,
  k: typewriterK, l: typewriterL, m: typewriterM, n: typewriterN, o: typewriterO,
  p: typewriterP, q: typewriterQ, r: typewriterR, s: typewriterS, t: typewriterT,
  u: typewriterU, v: typewriterV, w: typewriterW, x: typewriterX, y: typewriterY,
  z: typewriterZ,
} as const;
