import { ElizaOS, Agent, Inference } from "@/lib/core";
import {
  multiverseAdd,
  multiverseSubtract,
  multiverseMultiply,
  multiverseDivide,
  multiverseModulo,
} from "@/plugins/plugin-tool-bench";
import { stepCountIs, type Tool } from "ai";

// Initialize ElizaOS
const elizaOS = new ElizaOS();

const tools: Record<string, Tool> = {
  // Add multiverse math tools for benchmarking
  multiverseAdd,
  multiverseSubtract,
  multiverseMultiply,
  multiverseDivide,
  multiverseModulo,
};

// Create agent with multiverse math tools for benchmarking
const agent = new Agent({
  model: Inference.getModel("gpt-5-mini"),
  tools,
  stopWhen: stepCountIs(15),
  system: `You are a multiverse mathematician with access to fantasy mathematical operations.
  
MULTIVERSE MATH TOOLS:
You have access to multiverse math tools that perform mathematical operations in different dimensions:
- multiverseAdd: Addition with dimensional constants (quantum, chaos, prime)
- multiverseSubtract: Subtraction where negative numbers might not exist (absolute, mirror, void)
- multiverseMultiply: Multiplication with exotic behaviors (fibonacci, exponential, harmonic)
- multiverseDivide: Division where zero has special meaning (safe, infinite, golden)
- multiverseModulo: Modulo with cyclical properties (cyclical, spiral, fractal)

Each math operation takes two numbers (a and b) and a dimension parameter that changes how the math works.
Always explain what dimension you're using and why the result is different from normal math.`,
});

elizaOS.addAgent(agent, "default");

console.log("🌌 Multiverse Math Benchmark Test");
console.log("==================================\n");

// Test 1: Quantum Addition
console.log("Test 1: Quantum Addition");
const quantumAdd = await agent.generate({
  prompt:
    "Calculate 42 + 17 in the quantum dimension using multiverseAdd. Explain the quantum entanglement factor.",
});
console.log("Result:", quantumAdd.text);
console.log("---\n");

// Test 2: Fibonacci Multiplication
console.log("Test 2: Fibonacci Multiplication");
const fibMultiply = await agent.generate({
  prompt:
    "Calculate 13 * 7 in the fibonacci dimension using multiverseMultiply. Show how it snaps to Fibonacci numbers.",
});
console.log("Result:", fibMultiply.text);
console.log("---\n");

// Test 3: Division by Zero in Infinite Dimension
console.log("Test 3: Portal Opening (Division by Zero)");
const portalDivide = await agent.generate({
  prompt:
    "Calculate 100 / 0 in the infinite dimension using multiverseDivide. This should open a portal!",
});
console.log("Result:", portalDivide.text);
console.log("---\n");

// Test 4: Complex Multi-dimensional Calculation
console.log("Test 4: Multi-dimensional Chain Calculation");
const complexCalc = await agent.generate({
  prompt:
    "First calculate 25 + 30 in the chaos dimension, then take that result and multiply it by 3 in the harmonic dimension. Use the appropriate multiverse tools for each step.",
});
console.log("Result:", complexCalc.text);
console.log("---\n");

// Show tool usage summary
const allToolCalls = [
  ...(quantumAdd.toolCalls || []),
  ...(fibMultiply.toolCalls || []),
  ...(portalDivide.toolCalls || []),
  ...(complexCalc.toolCalls || []),
];

console.log("📊 Benchmark Summary:");
console.log("--------------------");
console.log(`Total multiverse operations: ${allToolCalls.length}`);
allToolCalls.forEach((tc, i) => {
  console.log(`  ${i + 1}. ${tc.toolName} - inputs:`, tc.input);
});
console.log("\n✅ Multiverse math benchmark complete!\n");
