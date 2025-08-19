import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

// Helper function to generate a pseudo-random multiverse seed
function generateMultiverseSeed(a: number, b: number): number {
  const seed = ((a * 73) + (b * 37)) % 1000;
  return Math.abs(seed);
}

// Helper function to check if a number is prime
function isPrime(n: number): boolean {
  if (n <= 1) return false;
  if (n <= 3) return true;
  if (n % 2 === 0 || n % 3 === 0) return false;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

// Helper function to find the next prime number
function findNextPrime(n: number): number {
  if (n < 2) return 2;
  let candidate = Math.ceil(n);
  while (!isPrime(candidate)) {
    candidate++;
  }
  return candidate;
}

// Helper function to find nearest Fibonacci number
function findNearestFibonacci(n: number): number {
  const fibSeq = [0, 1];
  while (fibSeq[fibSeq.length - 1] < Math.abs(n)) {
    fibSeq.push(fibSeq[fibSeq.length - 1] + fibSeq[fibSeq.length - 2]);
  }
  
  const lastFib = fibSeq[fibSeq.length - 1];
  const prevFib = fibSeq[fibSeq.length - 2];
  
  return Math.abs(n - lastFib) < Math.abs(n - prevFib) ? lastFib : prevFib;
}

// Helper to safely parse numbers from state
function getStateValue(state: State | undefined, key: string, defaultValue: number = 0): number {
  const value = state?.values?.[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

// Number input actions (0-9)
function createNumberAction(digit: number): Action {
  return {
    name: `INPUT_${digit}`,
    similes: [`INPUT_${digit}`, `TYPE_${digit}`, `ENTER_${digit}`],
    description: `Input the number ${digit} into the current calculation buffer.`,
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      state?: State,
      _options?: Record<string, unknown>,
      callback?: HandlerCallback
    ): Promise<ActionResult> => {
      const currentBuffer = getStateValue(state, "inputBuffer", 0);
      const newBuffer = currentBuffer * 10 + digit;
      
      if (callback) {
        await callback({
          text: `Input: ${newBuffer}`,
          source: message.content.source,
        });
      }

      return {
        success: true,
        text: `Input: ${newBuffer}`,
        values: {
          inputBuffer: newBuffer,
          lastInput: digit,
        },
        data: {
          digit,
          buffer: newBuffer,
        },
      };
    },
    examples: [
      [
        {
          name: "{{user}}",
          content: { text: `input ${digit}` },
        },
        {
          name: "{{agent}}",
          content: {
            text: `Input: ${digit}`,
            actions: [`INPUT_${digit}`],
          },
        },
      ],
    ] as ActionExample[][],
  };
}

// Dimension selector action
const selectDimensionAction: Action = {
  name: "SELECT_DIMENSION",
  similes: ["DIMENSION", "SET_DIMENSION", "CHOOSE_DIMENSION"],
  description: "Select the dimensional constant that affects how mathematical operations behave in the multiverse.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Parse dimension from message content
    const content = message.content.text?.toLowerCase() || "";
    let dimension = "standard";
    
    if (content.includes("quantum")) dimension = "quantum";
    else if (content.includes("chaos")) dimension = "chaos";
    else if (content.includes("prime")) dimension = "prime";
    else if (content.includes("mirror")) dimension = "mirror";
    else if (content.includes("void")) dimension = "void";
    else if (content.includes("absolute")) dimension = "absolute";
    else if (content.includes("fibonacci")) dimension = "fibonacci";
    else if (content.includes("exponential")) dimension = "exponential";
    else if (content.includes("harmonic")) dimension = "harmonic";
    else if (content.includes("infinite")) dimension = "infinite";
    else if (content.includes("golden")) dimension = "golden";
    else if (content.includes("spiral")) dimension = "spiral";
    else if (content.includes("fractal")) dimension = "fractal";
    else if (content.includes("cyclical")) dimension = "cyclical";
    
    const text = `Dimension set to: ${dimension}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        dimension,
      },
      data: {
        dimension,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "set dimension to quantum" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Dimension set to: quantum",
          actions: ["SELECT_DIMENSION"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Add Action
const multiverseAddAction: Action = {
  name: "MULTIVERSE_ADD",
  similes: ["M_ADD", "MULTI_ADD", "DIMENSIONAL_ADD"],
  description: "Performs addition in the multiverse where numbers behave differently based on dimensional constants (prime, quantum, or chaos).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 0);
    const b = getStateValue(state, "inputBuffer", 0);
    const dimension = state?.values?.dimension || "prime";
    
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "quantum":
        // In quantum dimension, addition creates superposition
        result = a + b + Math.sqrt(Math.abs(a * b));
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
        const nextPrime = findNextPrime(Math.abs(standardResult));
        result = standardResult < 0 ? -nextPrime : nextPrime;
        explanation = `In prime dimension: ${a} + ${b} = ${result} (elevated to nearest prime from ${standardResult})`;
        break;
    }
    
    result = Math.round(result * 1000) / 1000; // Round to 3 decimal places
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        inputBuffer: 0,
        lastOperation: "multiverse_add",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_add",
        inputs: { a, b, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "add in quantum dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In quantum dimension: 0 + 0 = 0 (includes quantum entanglement factor √(0×0))",
          actions: ["MULTIVERSE_ADD"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Subtract Action
const multiverseSubtractAction: Action = {
  name: "MULTIVERSE_SUBTRACT",
  similes: ["M_SUBTRACT", "MULTI_SUB", "DIMENSIONAL_SUBTRACT"],
  description: "Performs subtraction in the multiverse where negative numbers might not exist in some dimensions (absolute, mirror, or void).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 0);
    const b = getStateValue(state, "inputBuffer", 0);
    const dimension = state?.values?.dimension || "absolute";
    
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
    
    result = Math.round(result * 1000) / 1000;
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        inputBuffer: 0,
        lastOperation: "multiverse_subtract",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_subtract",
        inputs: { a, b, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "subtract in mirror dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In mirror dimension: 0 - 0 = 0 (reflected subtraction)",
          actions: ["MULTIVERSE_SUBTRACT"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Multiply Action
const multiverseMultiplyAction: Action = {
  name: "MULTIVERSE_MULTIPLY",
  similes: ["M_MULTIPLY", "MULTI_MUL", "DIMENSIONAL_MULTIPLY"],
  description: "Performs multiplication across dimensional boundaries with exotic number behaviors (fibonacci, exponential, or harmonic).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 1);
    const b = getStateValue(state, "inputBuffer", 1);
    const dimension = state?.values?.dimension || "fibonacci";
    
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "exponential":
        // In exponential dimension, multiplication compounds
        result = Math.pow(Math.abs(a), Math.abs(b)) * (a < 0 || b < 0 ? -1 : 1);
        explanation = `In exponential dimension: ${a} × ${b} = ${result} (actually ${a}^${b})`;
        break;
      case "harmonic":
        // In harmonic dimension, multiplication creates harmonics
        const harmonic = (a * b) + ((a + b) / 2);
        result = harmonic;
        explanation = `In harmonic dimension: ${a} × ${b} = ${result} (includes harmonic mean)`;
        break;
      case "fibonacci":
      default:
        // In fibonacci dimension, results snap to fibonacci numbers
        const standard = a * b;
        result = findNearestFibonacci(standard) * (standard < 0 ? -1 : 1);
        explanation = `In fibonacci dimension: ${a} × ${b} = ${result} (nearest Fibonacci to ${standard})`;
        break;
    }
    
    result = Math.round(result * 1000) / 1000;
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        inputBuffer: 0,
        lastOperation: "multiverse_multiply",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_multiply",
        inputs: { a, b, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "multiply in exponential dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In exponential dimension: 1 × 1 = 1 (actually 1^1)",
          actions: ["MULTIVERSE_MULTIPLY"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Divide Action
const multiverseDivideAction: Action = {
  name: "MULTIVERSE_DIVIDE",
  similes: ["M_DIVIDE", "MULTI_DIV", "DIMENSIONAL_DIVIDE"],
  description: "Performs division in the multiverse where infinity and zero have special meanings (safe, infinite, or golden).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 0);
    const b = getStateValue(state, "inputBuffer", 1);
    const dimension = state?.values?.dimension || "safe";
    
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
        const standard = b === 0 ? 0 : a / b;
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
    
    result = Math.round(result * 1000) / 1000;
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        inputBuffer: 0,
        lastOperation: "multiverse_divide",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_divide",
        inputs: { a, b, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "divide in golden dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In golden dimension: 0 ÷ 1 = 0.809 (converging to φ)",
          actions: ["MULTIVERSE_DIVIDE"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Modulo Action
const multiverseModuloAction: Action = {
  name: "MULTIVERSE_MODULO",
  similes: ["M_MODULO", "MULTI_MOD", "DIMENSIONAL_MODULO"],
  description: "Performs modulo operation in the multiverse with cyclical dimensional properties (cyclical, spiral, or fractal).",
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    const b = getStateValue(state, "inputBuffer", 1);
    return b !== 0;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 0);
    const b = getStateValue(state, "inputBuffer", 1);
    const dimension = state?.values?.dimension || "cyclical";
    
    let result: number;
    let explanation: string;
    
    if (b === 0) {
      return {
        success: false,
        text: "Error: Cannot modulo by zero",
        values: state?.values || {},
      };
    }
    
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
    
    result = Math.round(result * 100) / 100;
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        inputBuffer: 0,
        lastOperation: "multiverse_modulo",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_modulo",
        inputs: { a, b, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "modulo in fractal dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In fractal dimension: 0 % 1 = 0 (after 3 fractal iterations)",
          actions: ["MULTIVERSE_MODULO"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Power Action
const multiversePowerAction: Action = {
  name: "MULTIVERSE_POWER",
  similes: ["M_POWER", "MULTI_POW", "DIMENSIONAL_POWER"],
  description: "Raises numbers to powers in the multiverse with dimensional effects (standard, imaginary, or recursive).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 0);
    const b = getStateValue(state, "inputBuffer", 2);
    const dimension = state?.values?.dimension || "standard";
    
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "imaginary":
        // In imaginary dimension, powers oscillate
        const oscillation = Math.cos(b * Math.PI / 2);
        result = Math.pow(Math.abs(a), b) * oscillation;
        explanation = `In imaginary dimension: ${a}^${b} = ${result} (oscillation factor: ${oscillation.toFixed(2)})`;
        break;
      case "recursive":
        // In recursive dimension, power is applied iteratively
        result = a;
        for (let i = 0; i < Math.min(Math.abs(b), 5); i++) {
          result = Math.pow(result, 1.5);
        }
        explanation = `In recursive dimension: ${a}^${b} = ${result} (${Math.min(Math.abs(b), 5)} recursive applications)`;
        break;
      case "standard":
      default:
        result = Math.pow(a, b);
        explanation = `In standard dimension: ${a}^${b} = ${result}`;
        break;
    }
    
    result = Math.round(result * 1000) / 1000;
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        inputBuffer: 0,
        lastOperation: "multiverse_power",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_power",
        inputs: { a, b, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "power in imaginary dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In imaginary dimension: 0^2 = 0 (oscillation factor: -1.00)",
          actions: ["MULTIVERSE_POWER"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Multiverse Square Root Action
const multiverseSqrtAction: Action = {
  name: "MULTIVERSE_SQRT",
  similes: ["M_SQRT", "MULTI_ROOT", "DIMENSIONAL_SQRT"],
  description: "Takes square root in the multiverse with dimensional variations (positive, complex, or quantum).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const a = getStateValue(state, "accumulator", 0);
    const dimension = state?.values?.dimension || "positive";
    
    let result: number;
    let explanation: string;
    
    switch (dimension) {
      case "complex":
        // In complex dimension, negative numbers have positive roots
        result = Math.sqrt(Math.abs(a));
        if (a < 0) {
          explanation = `In complex dimension: √${a} = ${result}i (imaginary component)`;
        } else {
          explanation = `In complex dimension: √${a} = ${result} (real component)`;
        }
        break;
      case "quantum":
        // In quantum dimension, square root creates superposition
        const superposition = Math.sqrt(Math.abs(a)) + (Math.random() - 0.5) * 0.1;
        result = Math.abs(superposition);
        explanation = `In quantum dimension: √${a} = ${result} (quantum fluctuation)`;
        break;
      case "positive":
      default:
        // In positive dimension, always returns positive
        result = Math.sqrt(Math.abs(a));
        explanation = `In positive dimension: √${a} = ${result} (absolute square root)`;
        break;
    }
    
    result = Math.round(result * 1000) / 1000;
    
    if (callback) {
      await callback({ text: explanation, source: message.content.source });
    }

    return {
      success: true,
      text: explanation,
      values: {
        accumulator: result,
        lastOperation: "multiverse_sqrt",
        dimension,
        history: [...(state?.values?.history || []), explanation],
      },
      data: {
        operation: "multiverse_sqrt",
        inputs: { a, dimension },
        result,
        explanation,
        timestamp: new Date().toISOString(),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "square root in complex dimension" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "In complex dimension: √0 = 0 (real component)",
          actions: ["MULTIVERSE_SQRT"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Utility actions
const clearAction: Action = {
  name: "MATH_CLEAR",
  similes: ["CLEAR", "RESET", "CLEAR_ALL"],
  description: "Clear all calculation buffers and reset to zero.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = "Cleared all buffers";
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        accumulator: 0,
        inputBuffer: 0,
        lastOperation: "clear",
        dimension: "standard",
        history: [],
      },
      data: {
        operation: "clear",
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "clear" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Cleared all buffers",
          actions: ["MATH_CLEAR"],
        },
      },
    ],
  ] as ActionExample[][],
};

const storeAction: Action = {
  name: "MATH_STORE",
  similes: ["STORE", "SAVE", "MEMORY_STORE"],
  description: "Store current accumulator value to memory.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const accumulator = getStateValue(state, "accumulator", 0);
    const text = `Stored ${accumulator} to memory`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        memory: accumulator,
        lastOperation: "store",
      },
      data: {
        operation: "store",
        value: accumulator,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "store to memory" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Stored 0 to memory",
          actions: ["MATH_STORE"],
        },
      },
    ],
  ] as ActionExample[][],
};

const recallAction: Action = {
  name: "MATH_RECALL",
  similes: ["RECALL", "LOAD", "MEMORY_RECALL"],
  description: "Recall value from memory to input buffer.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const memory = getStateValue(state, "memory", 0);
    const text = `Recalled ${memory} from memory`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        inputBuffer: memory,
        lastOperation: "recall",
      },
      data: {
        operation: "recall",
        value: memory,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "recall from memory" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Recalled 0 from memory",
          actions: ["MATH_RECALL"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Transfer accumulator to input buffer
const transferAction: Action = {
  name: "TRANSFER_TO_INPUT",
  similes: ["TRANSFER", "MOVE_TO_INPUT", "ACCUMULATOR_TO_INPUT"],
  description: "Transfer accumulator value to input buffer for next operation.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const accumulator = getStateValue(state, "accumulator", 0);
    const text = `Transferred ${accumulator} from accumulator to input buffer`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        inputBuffer: accumulator,
        accumulator: 0,
        lastOperation: "transfer",
      },
      data: {
        operation: "transfer",
        value: accumulator,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "transfer to input" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Transferred 0 from accumulator to input buffer",
          actions: ["TRANSFER_TO_INPUT"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Export all multiverse math actions
export const multiverseMathActions: Action[] = [
  // Number inputs
  ...Array.from({ length: 10 }, (_, i) => createNumberAction(i)),
  // Dimension selector
  selectDimensionAction,
  // Multiverse operations
  multiverseAddAction,
  multiverseSubtractAction,
  multiverseMultiplyAction,
  multiverseDivideAction,
  multiverseModuloAction,
  multiversePowerAction,
  multiverseSqrtAction,
  // Utility operations
  clearAction,
  storeAction,
  recallAction,
  transferAction,
];