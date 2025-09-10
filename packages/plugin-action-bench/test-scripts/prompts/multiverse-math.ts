/**
 * Multiverse Math benchmark test prompts
 */

import { TestPrompt } from "../types";

export const multiverseMathPrompts: TestPrompt[] = [
  // Basic number input tests
  {
    id: "math-input-single-5",
    category: "multiverse-math",
    prompt: "input 5",
    expectedPatterns: ["5", "input*5", "buffer*5"],
    expectedActions: ["INPUT_5"],
  },
  {
    id: "math-input-multi-42",
    category: "multiverse-math",
    prompt: "input 42",
    expectedPatterns: ["42", "input*42", "buffer*42"],
    expectedActions: ["INPUT_4", "INPUT_2"],
  },
  {
    id: "math-input-long-12345",
    category: "multiverse-math",
    prompt: "input 12345",
    expectedPatterns: ["12345", "input*12345", "buffer*12345"],
    expectedActions: ["INPUT_1", "INPUT_2", "INPUT_3", "INPUT_4", "INPUT_5"],
  },

  // Dimension selection tests
  {
    id: "math-dimension-quantum",
    category: "multiverse-math",
    prompt: "set dimension to quantum",
    expectedPatterns: ["quantum", "dimension*quantum", "selected*quantum"],
    expectedActions: ["SELECT_DIMENSION"],
  },
  {
    id: "math-dimension-chaos",
    category: "multiverse-math",
    prompt: "select chaos dimension",
    expectedPatterns: ["chaos", "dimension*chaos", "selected*chaos"],
    expectedActions: ["SELECT_DIMENSION"],
  },
  {
    id: "math-dimension-fibonacci",
    category: "multiverse-math",
    prompt: "switch to fibonacci dimension",
    expectedPatterns: ["fibonacci", "dimension*fibonacci", "selected*fibonacci"],
    expectedActions: ["SELECT_DIMENSION"],
  },

  // Basic addition tests in different dimensions
  {
    id: "math-add-standard",
    category: "multiverse-math",
    prompt: "add 5 and 3",
    expectedPatterns: ["8", "5 + 3", "result*8"],
    expectedActions: ["INPUT_5", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_ADD"],
  },
  {
    id: "math-add-prime",
    category: "multiverse-math",
    prompt: "in prime dimension, add 5 and 3",
    expectedPatterns: ["11", "prime", "nearest prime"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_5", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_ADD"],
    setup: [
      {
        id: "math-add-prime-setup",
        category: "multiverse-math",
        prompt: "set dimension to prime",
        expectedPatterns: ["prime"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },
  {
    id: "math-add-quantum",
    category: "multiverse-math",
    prompt: "add 5 and 3 with quantum entanglement",
    expectedPatterns: ["*10*", "quantum", "entanglement"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_5", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_ADD"],
    setup: [
      {
        id: "math-add-quantum-setup",
        category: "multiverse-math",
        prompt: "set dimension to quantum",
        expectedPatterns: ["quantum"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },

  // Subtraction tests
  {
    id: "math-subtract-standard",
    category: "multiverse-math",
    prompt: "subtract 3 from 10",
    expectedPatterns: ["7", "10 - 3", "result*7"],
    expectedActions: ["INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_SUBTRACT"],
  },
  {
    id: "math-subtract-absolute",
    category: "multiverse-math",
    prompt: "in absolute dimension, subtract 10 from 3",
    expectedPatterns: ["7", "absolute", "no negative"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_3", "TRANSFER_TO_INPUT", "INPUT_1", "INPUT_0", "MULTIVERSE_SUBTRACT"],
    setup: [
      {
        id: "math-subtract-absolute-setup",
        category: "multiverse-math",
        prompt: "set dimension to absolute",
        expectedPatterns: ["absolute"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },
  {
    id: "math-subtract-mirror",
    category: "multiverse-math",
    prompt: "subtract 5 from 8 in mirror dimension",
    expectedPatterns: ["-3", "mirror", "reflect"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_8", "TRANSFER_TO_INPUT", "INPUT_5", "MULTIVERSE_SUBTRACT"],
    setup: [
      {
        id: "math-subtract-mirror-setup",
        category: "multiverse-math",
        prompt: "set dimension to mirror",
        expectedPatterns: ["mirror"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },

  // Multiplication tests
  {
    id: "math-multiply-standard",
    category: "multiverse-math",
    prompt: "multiply 7 by 8",
    expectedPatterns: ["56", "7 * 8", "7 × 8", "result*56"],
    expectedActions: ["INPUT_7", "TRANSFER_TO_INPUT", "INPUT_8", "MULTIVERSE_MULTIPLY"],
  },
  {
    id: "math-multiply-fibonacci",
    category: "multiverse-math",
    prompt: "multiply 7 by 8 in fibonacci dimension",
    expectedPatterns: ["55", "fibonacci", "nearest fibonacci"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_7", "TRANSFER_TO_INPUT", "INPUT_8", "MULTIVERSE_MULTIPLY"],
    setup: [
      {
        id: "math-multiply-fibonacci-setup",
        category: "multiverse-math",
        prompt: "set dimension to fibonacci",
        expectedPatterns: ["fibonacci"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },
  {
    id: "math-multiply-exponential",
    category: "multiverse-math",
    prompt: "in exponential dimension, multiply 2 by 3",
    expectedPatterns: ["8", "exponential", "2^3"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_2", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_MULTIPLY"],
    setup: [
      {
        id: "math-multiply-exponential-setup",
        category: "multiverse-math",
        prompt: "set dimension to exponential",
        expectedPatterns: ["exponential"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },

  // Division tests
  {
    id: "math-divide-standard",
    category: "multiverse-math",
    prompt: "divide 10 by 2",
    expectedPatterns: ["5", "10 / 2", "10 ÷ 2", "result*5"],
    expectedActions: ["INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_2", "MULTIVERSE_DIVIDE"],
  },
  {
    id: "math-divide-by-zero-safe",
    category: "multiverse-math",
    prompt: "divide 10 by 0",
    expectedPatterns: ["10", "safe", "division by zero"],
    expectedActions: ["INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_0", "MULTIVERSE_DIVIDE"],
  },
  {
    id: "math-divide-by-zero-infinite",
    category: "multiverse-math",
    prompt: "in infinite dimension, divide 10 by 0",
    expectedPatterns: ["9990", "portal", "infinite"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_0", "MULTIVERSE_DIVIDE"],
    setup: [
      {
        id: "math-divide-infinite-setup",
        category: "multiverse-math",
        prompt: "set dimension to infinite",
        expectedPatterns: ["infinite"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },
  {
    id: "math-divide-golden",
    category: "multiverse-math",
    prompt: "divide 10 by 3 in golden dimension",
    expectedPatterns: ["*2*", "golden", "phi", "φ"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_DIVIDE"],
    setup: [
      {
        id: "math-divide-golden-setup",
        category: "multiverse-math",
        prompt: "set dimension to golden",
        expectedPatterns: ["golden"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },

  // Modulo tests
  {
    id: "math-modulo-standard",
    category: "multiverse-math",
    prompt: "calculate 10 modulo 3",
    expectedPatterns: ["1", "10 % 3", "10 mod 3", "result*1"],
    expectedActions: ["INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_MODULO"],
  },
  {
    id: "math-modulo-cyclical",
    category: "multiverse-math",
    prompt: "in cyclical dimension, calculate 10 modulo 3",
    expectedPatterns: ["1", "cyclical", "cycle"],
    expectedActions: ["SELECT_DIMENSION", "INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_MODULO"],
    setup: [
      {
        id: "math-modulo-cyclical-setup",
        category: "multiverse-math",
        prompt: "set dimension to cyclical",
        expectedPatterns: ["cyclical"],
        expectedActions: ["SELECT_DIMENSION"],
      }
    ],
  },

  // Power tests
  {
    id: "math-power-standard",
    category: "multiverse-math",
    prompt: "calculate 2 to the power of 3",
    expectedPatterns: ["8", "2^3", "2 ^ 3", "result*8"],
    expectedActions: ["INPUT_2", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_POWER"],
  },
  {
    id: "math-power-large",
    category: "multiverse-math",
    prompt: "calculate 3 to the power of 4",
    expectedPatterns: ["81", "3^4", "3 ^ 4", "result*81"],
    expectedActions: ["INPUT_3", "TRANSFER_TO_INPUT", "INPUT_4", "MULTIVERSE_POWER"],
  },

  // Square root tests
  {
    id: "math-sqrt-standard",
    category: "multiverse-math",
    prompt: "calculate square root of 16",
    expectedPatterns: ["4", "√16", "sqrt(16)", "result*4"],
    expectedActions: ["INPUT_1", "INPUT_6", "MULTIVERSE_SQRT"],
  },
  {
    id: "math-sqrt-negative",
    category: "multiverse-math",
    prompt: "calculate square root of -16",
    expectedPatterns: ["4", "imaginary", "4i"],
    expectedActions: ["INPUT_1", "INPUT_6", "MULTIVERSE_SQRT"],
  },

  // Memory operations
  {
    id: "math-store-recall",
    category: "multiverse-math",
    prompt: "add 5 and 3, store it, then recall",
    expectedPatterns: ["8", "stored", "recalled"],
    expectedActions: ["INPUT_5", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_ADD", "MATH_STORE", "MATH_RECALL"],
  },
  {
    id: "math-clear",
    category: "multiverse-math",
    prompt: "clear all math buffers",
    expectedPatterns: ["clear", "reset", "buffers cleared"],
    expectedActions: ["MATH_CLEAR"],
  },

  // Complex multi-step calculations
  {
    id: "math-complex-chain",
    category: "multiverse-math",
    prompt: "add 10 and 5, then multiply by 2, then divide by 3",
    expectedPatterns: ["10", "15", "30", "10"],
    expectedActions: [
      "INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_5", "MULTIVERSE_ADD",
      "TRANSFER_TO_INPUT", "INPUT_2", "MULTIVERSE_MULTIPLY",
      "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_DIVIDE"
    ],
    timeout: 8000,
  },
  {
    id: "math-dimension-switching",
    category: "multiverse-math",
    prompt: "add 10 and 5 in prime dimension, then divide by 3 in golden dimension",
    expectedPatterns: ["17", "prime", "golden", "phi"],
    expectedActions: [
      "SELECT_DIMENSION", "INPUT_1", "INPUT_0", "TRANSFER_TO_INPUT", "INPUT_5", "MULTIVERSE_ADD",
      "SELECT_DIMENSION", "TRANSFER_TO_INPUT", "INPUT_3", "MULTIVERSE_DIVIDE"
    ],
    timeout: 10000,
  },

  // Edge cases and error handling
  {
    id: "math-no-input",
    category: "multiverse-math",
    prompt: "add without any numbers",
    expectedPatterns: ["*number*", "*input*", "*specify*"],
    expectedActions: [],
  },
  {
    id: "math-invalid-dimension",
    category: "multiverse-math",
    prompt: "set dimension to imaginary",
    expectedPatterns: ["*not*", "*invalid*", "*unknown*", "*dimension*"],
    expectedActions: [],
  },
];
