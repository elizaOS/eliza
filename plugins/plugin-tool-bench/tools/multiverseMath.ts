import { tool } from "ai";
import { z } from "zod";

/**
 * Multiverse Math Tools - Fantasy mathematical operations for benchmarking
 * These tools perform fictional math operations that exist in alternate universes
 */

// Helper function to generate a pseudo-random multiverse seed
function generateMultiverseSeed(a: number, b: number): number {
  const seed = ((a * 73) + (b * 37)) % 1000;
  return Math.abs(seed);
}

export const multiverseAdd = tool({
  description: "Performs addition in the multiverse where numbers behave differently based on dimensional constants",
  inputSchema: z.object({
    a: z
      .number()
      .describe("First number to add"),
    b: z
      .number()
      .describe("Second number to add"),
    dimension: z
      .string()
      .default("prime")
      .describe("The dimensional constant affecting the operation (prime, quantum, or chaos)"),
  }),
  execute: async ({ a, b, dimension }) => {
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "quantum":
        // In quantum dimension, addition creates superposition
        result = a + b + Math.sqrt(a * b);
        explanation = `In quantum dimension: ${a} + ${b} = ${result} (includes quantum entanglement factor √(${a}×${b}))`;
        break;
      case "chaos":
        // In chaos dimension, results are unpredictable but deterministic
        const seed = generateMultiverseSeed(a, b);
        result = a + b + (seed % 10);
        explanation = `In chaos dimension: ${a} + ${b} = ${result} (chaos factor: ${seed % 10})`;
        break;
      case "prime":
      default:
        // In prime dimension, only prime numbers truly exist
        const standardResult = a + b;
        const nextPrime = findNextPrime(standardResult);
        result = nextPrime;
        explanation = `In prime dimension: ${a} + ${b} = ${result} (elevated to nearest prime from ${standardResult})`;
        break;
    }
    
    return {
      success: true,
      operation: "multiverse_add",
      inputs: { a, b, dimension },
      result,
      explanation,
      timestamp: new Date().toISOString(),
    };
  },
});

export const multiverseSubtract = tool({
  description: "Performs subtraction in the multiverse where negative numbers might not exist in some dimensions",
  inputSchema: z.object({
    a: z
      .number()
      .describe("Number to subtract from"),
    b: z
      .number()
      .describe("Number to subtract"),
    dimension: z
      .string()
      .default("absolute")
      .describe("The dimensional constant (absolute, mirror, or void)"),
  }),
  execute: async ({ a, b, dimension }) => {
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "mirror":
        // In mirror dimension, subtraction reflects across zero
        result = Math.abs(a - b) * (a > b ? 1 : -1) * 2;
        explanation = `In mirror dimension: ${a} - ${b} = ${result} (reflected subtraction)`;
        break;
      case "void":
        // In void dimension, subtraction creates voids (always positive)
        result = Math.abs(a - b) + Math.min(a, b);
        explanation = `In void dimension: ${a} - ${b} = ${result} (void compensation: +${Math.min(a, b)})`;
        break;
      case "absolute":
      default:
        // In absolute dimension, negative numbers don't exist
        result = Math.abs(a - b);
        explanation = `In absolute dimension: ${a} - ${b} = ${result} (absolute value universe)`;
        break;
    }
    
    return {
      success: true,
      operation: "multiverse_subtract",
      inputs: { a, b, dimension },
      result,
      explanation,
      timestamp: new Date().toISOString(),
    };
  },
});

export const multiverseMultiply = tool({
  description: "Performs multiplication across dimensional boundaries with exotic number behaviors",
  inputSchema: z.object({
    a: z
      .number()
      .describe("First multiplicand"),
    b: z
      .number()
      .describe("Second multiplicand"),
    dimension: z
      .string()
      .default("fibonacci")
      .describe("The dimensional constant (fibonacci, exponential, or harmonic)"),
  }),
  execute: async ({ a, b, dimension }) => {
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "exponential":
        // In exponential dimension, multiplication compounds
        result = Math.pow(a, b);
        explanation = `In exponential dimension: ${a} × ${b} = ${result} (actually ${a}^${b})`;
        break;
      case "harmonic":
        // In harmonic dimension, multiplication creates harmonics
        const harmonic = (a * b) + ((a + b) / 2);
        result = Math.round(harmonic * 100) / 100;
        explanation = `In harmonic dimension: ${a} × ${b} = ${result} (includes harmonic mean)`;
        break;
      case "fibonacci":
      default:
        // In fibonacci dimension, results snap to fibonacci numbers
        const standard = a * b;
        result = findNearestFibonacci(standard);
        explanation = `In fibonacci dimension: ${a} × ${b} = ${result} (nearest Fibonacci to ${standard})`;
        break;
    }
    
    return {
      success: true,
      operation: "multiverse_multiply",
      inputs: { a, b, dimension },
      result,
      explanation,
      timestamp: new Date().toISOString(),
    };
  },
});

export const multiverseDivide = tool({
  description: "Performs division in the multiverse where infinity and zero have special meanings",
  inputSchema: z.object({
    a: z
      .number()
      .describe("Dividend"),
    b: z
      .number()
      .describe("Divisor"),
    dimension: z
      .string()
      .default("safe")
      .describe("The dimensional constant (safe, infinite, or golden)"),
  }),
  execute: async ({ a, b, dimension }) => {
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "infinite":
        // In infinite dimension, division by zero opens portals
        if (b === 0) {
          result = a * 999; // Portal multiplier
          explanation = `In infinite dimension: ${a} ÷ 0 = ${result} (portal opened!)`;
        } else {
          result = (a / b) * Math.PI;
          explanation = `In infinite dimension: ${a} ÷ ${b} = ${result} (π-scaled)`;
        }
        break;
      case "golden":
        // In golden dimension, all division tends toward golden ratio
        const goldenRatio = 1.618033988749895;
        const standard = a / b;
        result = (standard + goldenRatio) / 2;
        explanation = `In golden dimension: ${a} ÷ ${b} = ${result} (converging to φ)`;
        break;
      case "safe":
      default:
        // In safe dimension, division by zero returns the dividend
        result = b === 0 ? a : a / b;
        explanation = b === 0 
          ? `In safe dimension: ${a} ÷ 0 = ${a} (safe division, returns dividend)`
          : `In safe dimension: ${a} ÷ ${b} = ${result} (standard division)`;
        break;
    }
    
    return {
      success: true,
      operation: "multiverse_divide",
      inputs: { a, b, dimension },
      result: Math.round(result * 1000) / 1000, // Round to 3 decimal places
      explanation,
      timestamp: new Date().toISOString(),
    };
  },
});

export const multiverseModulo = tool({
  description: "Performs modulo operation in the multiverse with cyclical dimensional properties",
  inputSchema: z.object({
    a: z
      .number()
      .describe("Number to take modulo of"),
    b: z
      .number()
      .describe("Modulo base"),
    dimension: z
      .string()
      .default("cyclical")
      .describe("The dimensional constant (cyclical, spiral, or fractal)"),
  }),
  execute: async ({ a, b, dimension }) => {
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "spiral":
        // In spiral dimension, modulo creates spiraling patterns
        const spiralFactor = Math.sin(a) * Math.cos(b);
        result = Math.abs((a % b) + spiralFactor * 10);
        explanation = `In spiral dimension: ${a} % ${b} = ${result} (spiral factor: ${spiralFactor.toFixed(2)})`;
        break;
      case "fractal":
        // In fractal dimension, modulo is self-similar at all scales
        const iterations = 3;
        result = a % b;
        for (let i = 0; i < iterations; i++) {
          result = (result * 2) % (b + i);
        }
        explanation = `In fractal dimension: ${a} % ${b} = ${result} (after ${iterations} fractal iterations)`;
        break;
      case "cyclical":
      default:
        // In cyclical dimension, modulo creates perfect cycles
        result = a % b;
        if (result < 0) result += b; // Always positive in cyclical dimension
        explanation = `In cyclical dimension: ${a} % ${b} = ${result} (perfect cycle)`;
        break;
    }
    
    return {
      success: true,
      operation: "multiverse_modulo",
      inputs: { a, b, dimension },
      result: Math.round(result * 100) / 100,
      explanation,
      timestamp: new Date().toISOString(),
    };
  },
});

// Helper functions
function isPrime(n: number): boolean {
  if (n <= 1) return false;
  if (n <= 3) return true;
  if (n % 2 === 0 || n % 3 === 0) return false;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

function findNextPrime(n: number): number {
  if (n < 2) return 2;
  let candidate = Math.ceil(n);
  while (!isPrime(candidate)) {
    candidate++;
  }
  return candidate;
}

function findNearestFibonacci(n: number): number {
  const fibSeq = [0, 1];
  while (fibSeq[fibSeq.length - 1] < n) {
    fibSeq.push(fibSeq[fibSeq.length - 1] + fibSeq[fibSeq.length - 2]);
  }
  
  const lastFib = fibSeq[fibSeq.length - 1];
  const prevFib = fibSeq[fibSeq.length - 2];
  
  return Math.abs(n - lastFib) < Math.abs(n - prevFib) ? lastFib : prevFib;
}

// Export all multiverse math tools as a collection
export const allMultiverseMathTools = [
  multiverseAdd,
  multiverseSubtract,
  multiverseMultiply,
  multiverseDivide,
  multiverseModulo,
];

export const multiverseMathToolMap = {
  add: multiverseAdd,
  subtract: multiverseSubtract,
  multiply: multiverseMultiply,
  divide: multiverseDivide,
  modulo: multiverseModulo,
} as const;
