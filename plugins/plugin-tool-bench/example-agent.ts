/**
 * Example of how to integrate the typewriter tools with an Eliza agent
 * This demonstrates using the tool-bench plugin in a real agent configuration
 */

import { Agent } from "@/lib/core/agent";
import { 
  typewriterA, typewriterB, typewriterC, typewriterD, typewriterE,
  typewriterF, typewriterG, typewriterH, typewriterI, typewriterJ,
  typewriterK, typewriterL, typewriterM, typewriterN, typewriterO,
  typewriterP, typewriterQ, typewriterR, typewriterS, typewriterT,
  typewriterU, typewriterV, typewriterW, typewriterX, typewriterY,
  typewriterZ,
  typewriterWord,
  typewriterSentence,
  typewriterBackspace,
  typewriterSpace,
  typewriterNewline,
} from "./index";

// Create an agent with all typewriter tools
export const typewriterAgent = new Agent({
  name: "Typewriter Agent",
  model: "gpt-4",
  systemPrompt: `You are a typewriter agent that can type letters, words, and sentences.
    You have access to individual letter tools (A-Z) and composite tools for words and sentences.
    When asked to type something, use the appropriate tools to complete the task.
    For single letters, use the individual letter tools.
    For words, you can either use individual letter tools or the typewriterWord tool.
    For sentences, use the typewriterSentence tool for efficiency.`,
  
  tools: {
    // Individual letter tools
    typewriterA,
    typewriterB,
    typewriterC,
    typewriterD,
    typewriterE,
    typewriterF,
    typewriterG,
    typewriterH,
    typewriterI,
    typewriterJ,
    typewriterK,
    typewriterL,
    typewriterM,
    typewriterN,
    typewriterO,
    typewriterP,
    typewriterQ,
    typewriterR,
    typewriterS,
    typewriterT,
    typewriterU,
    typewriterV,
    typewriterW,
    typewriterX,
    typewriterY,
    typewriterZ,
    
    // Composite tools
    typewriterWord,
    typewriterSentence,
    typewriterBackspace,
    typewriterSpace,
    typewriterNewline,
  },
});

// Example usage scenarios
export const exampleScenarios = [
  {
    name: "Type a single letter",
    prompt: "Type the letter H in uppercase",
    expectedTools: ["typewriterH"],
    expectedParams: { uppercase: true, repeat: 1 },
  },
  {
    name: "Type a word letter by letter",
    prompt: "Type the word HELLO letter by letter in uppercase",
    expectedTools: ["typewriterH", "typewriterE", "typewriterL", "typewriterL", "typewriterO"],
    alternativeTool: "typewriterWord",
    alternativeParams: { word: "HELLO", uppercase: true, spacing: 100 },
  },
  {
    name: "Type a sentence",
    prompt: "Type the sentence 'Hello, World!' with proper formatting",
    expectedTools: ["typewriterSentence"],
    expectedParams: { sentence: "Hello, World!", preserveCase: true, spacing: 50 },
  },
  {
    name: "Complex typing task",
    prompt: "Type ABC, then add 3 spaces, then type XYZ",
    expectedTools: [
      "typewriterA", "typewriterB", "typewriterC",
      "typewriterSpace",
      "typewriterX", "typewriterY", "typewriterZ"
    ],
  },
];

// Benchmark function to test tool selection
export async function benchmarkToolSelection(agent: Agent, prompt: string) {
  const startTime = performance.now();
  
  try {
    // This would normally be handled by the agent's internal tool selection
    // Here we're showing what the benchmark would measure
    const result = await agent.generateResponse(prompt);
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    return {
      prompt,
      duration,
      success: true,
      result,
    };
  } catch (error) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    return {
      prompt,
      duration,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Compare with action-based approach
export async function compareWithActions() {
  console.log("Comparing Tool-based vs Action-based approaches:");
  console.log("=================================================\n");
  
  console.log("Tool-based advantages:");
  console.log("- Built-in schema validation with Zod");
  console.log("- Type-safe inputs and outputs");
  console.log("- Standardized async execution");
  console.log("- Better error handling");
  console.log("- Integration with Vercel AI SDK");
  
  console.log("\nAction-based advantages:");
  console.log("- Potentially lower overhead");
  console.log("- Simpler registration");
  console.log("- Legacy compatibility");
  
  console.log("\nBenchmark areas:");
  console.log("1. Tool/Action discovery time");
  console.log("2. Validation overhead");
  console.log("3. Execution time");
  console.log("4. Memory usage");
  console.log("5. Agent reasoning quality");
}
