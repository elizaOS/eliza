# plugin-tool-bench

A benchmarking plugin for Eliza that provides 26 typewriter tools (one for each letter of the alphabet) plus composite tools for typing words and sentences. This plugin is designed to test and compare tool usage patterns versus the old action system.

## Purpose

This plugin serves as a benchmark for:
- Testing tool selection and routing capabilities
- Comparing performance between the new tool system and old action system
- Measuring overhead of having many similar tools available
- Evaluating agent's ability to choose the correct tool from many options

## Installation

Install dependencies:

```bash
bun install
```

## Tools Provided

### Individual Letter Tools (26 tools)

Each letter of the alphabet has its own tool:
- `typewriterA` through `typewriterZ`

Each letter tool accepts:
- `uppercase` (boolean): Whether to type the letter in uppercase
- `repeat` (number): Number of times to type the letter (1-10)

### Multiverse Math Tools (5 tools)

Fantasy mathematical operations that work differently in alternate dimensions:

- **multiverseAdd**: Addition with dimensional constants
  - Dimensions: `quantum` (includes entanglement), `chaos` (unpredictable), `prime` (elevates to primes)
  
- **multiverseSubtract**: Subtraction where negative numbers might not exist
  - Dimensions: `absolute` (no negatives), `mirror` (reflection), `void` (void compensation)
  
- **multiverseMultiply**: Multiplication with exotic behaviors
  - Dimensions: `fibonacci` (snaps to Fibonacci), `exponential` (power operation), `harmonic` (includes harmonics)
  
- **multiverseDivide**: Division where zero has special meaning
  - Dimensions: `safe` (division by zero returns dividend), `infinite` (portals!), `golden` (converges to φ)
  
- **multiverseModulo**: Modulo with cyclical properties
  - Dimensions: `cyclical` (perfect cycles), `spiral` (spiral patterns), `fractal` (self-similar)

### Composite Tools

- **typewriterWord**: Types a complete word letter by letter
  - `word` (string): The word to type (letters only)
  - `uppercase` (boolean): Whether to type in uppercase
  - `spacing` (number): Delay between letters in milliseconds

- **typewriterSentence**: Types a complete sentence including spaces and punctuation
  - `sentence` (string): The sentence to type
  - `preserveCase` (boolean): Whether to preserve original case
  - `spacing` (number): Delay between characters in milliseconds

- **typewriterBackspace**: Simulates pressing backspace
  - `count` (number): Number of characters to delete

- **typewriterSpace**: Types space characters
  - `count` (number): Number of spaces to type

- **typewriterNewline**: Types newline characters
  - `count` (number): Number of newlines to type

## Usage Example

### Typewriter Tools
```typescript
import { 
  typewriterH, 
  typewriterE, 
  typewriterL, 
  typewriterO,
  typewriterWord,
  typewriterSentence 
} from "plugin-tool-bench";

// Type individual letters
await typewriterH.execute({ uppercase: true, repeat: 1 });
await typewriterE.execute({ uppercase: false, repeat: 1 });
await typewriterL.execute({ uppercase: false, repeat: 2 });
await typewriterO.execute({ uppercase: false, repeat: 1 });

// Type a word
await typewriterWord.execute({ 
  word: "hello", 
  uppercase: false, 
  spacing: 100 
});

// Type a sentence
await typewriterSentence.execute({ 
  sentence: "Hello, World!", 
  preserveCase: true, 
  spacing: 50 
});
```

### Multiverse Math Tools
```typescript
import {
  multiverseAdd,
  multiverseMultiply,
  multiverseDivide
} from "plugin-tool-bench";

// Quantum addition (includes entanglement factor)
const quantumResult = await multiverseAdd.execute({
  a: 42,
  b: 17,
  dimension: "quantum"
});
// Result: 42 + 17 + √(42×17) = 59 + 26.68 = 85.68

// Fibonacci multiplication (snaps to Fibonacci numbers)
const fibResult = await multiverseMultiply.execute({
  a: 13,
  b: 7,
  dimension: "fibonacci"  
});
// Result: 13 × 7 = 91 → snaps to nearest Fibonacci = 89

// Division by zero opens portals!
const portalResult = await multiverseDivide.execute({
  a: 100,
  b: 0,
  dimension: "infinite"
});
// Result: 100 ÷ 0 = 99900 (portal opened!)
```

## Programmatic Access

The plugin also exports convenient collections:

```typescript
import { 
  allTypewriterTools,  // Array of all 26 letter tools
  typewriterToolMap    // Object mapping letters to their tools
} from "plugin-tool-bench";

// Use all tools
for (const tool of allTypewriterTools) {
  // Register or use tool
}

// Access specific tool by letter
const letterTool = typewriterToolMap['a'];
await letterTool.execute({ uppercase: false, repeat: 1 });
```

## Benchmarking vs plugin-action-bench

This plugin mirrors the functionality of `plugin-action-bench` but uses the new Eliza tool system instead of actions. Key differences:

- **Tools vs Actions**: Uses the new `tool` function from `ai` package
- **Schema Validation**: Uses Zod for input validation
- **Async Execution**: All tools are async by default
- **Structured Output**: Returns consistent result objects

## Development

Build the plugin:

```bash
bun run build
```

Run in development mode:

```bash
bun run dev
```

Clean build artifacts:

```bash
bun run clean
```

Format code:

```bash
bun run lint
```

## Comparison Metrics

When comparing with plugin-action-bench, consider measuring:
- Tool selection accuracy
- Response time for tool invocation
- Memory usage with many tools loaded
- Agent's reasoning about which tool to use
- Error handling and recovery

## License

This project is part of the Eliza ecosystem.
