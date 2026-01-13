#!/usr/bin/env bun
/**
 * Basic WASM Example
 *
 * Demonstrates loading and using the elizaOS WASM module with Bun.
 *
 * Run with:
 *   bun run examples/wasm/basic.ts
 *
 * Or make executable and run directly:
 *   chmod +x examples/wasm/basic.ts
 *   ./examples/wasm/basic.ts
 */

// Import the WASM module (Node.js target)
import * as elizaos from "../../pkg-node/elizaos.js";

async function main() {
  console.log("=== elizaOS WASM Basic Example ===\n");

  // Get version
  console.log(`Version: ${elizaos.getVersion()}`);

  // UUID operations
  console.log("\n--- UUID Operations ---");
  const uuid = elizaos.generateUUID();
  console.log(`Generated UUID: ${uuid}`);
  console.log(`Is valid: ${elizaos.validateUUID(uuid)}`);

  // Deterministic UUID from string
  const deterministicUuid = elizaos.stringToUuid("my-agent-name");
  console.log(`Deterministic UUID for 'my-agent-name': ${deterministicUuid}`);

  // Character parsing
  console.log("\n--- Character Parsing ---");
  const characterJson = JSON.stringify({
    name: "BunAgent",
    bio: "An agent running in Bun via WASM",
    system: "You are a helpful assistant running in a JavaScript runtime.",
    topics: ["programming", "javascript", "rust"],
    adjectives: ["helpful", "fast", "efficient"],
  });

  const character = elizaos.parseCharacter(characterJson);
  console.log(`Character name: ${character.name}`);
  console.log(`Character system: ${character.system}`);

  // Memory operations
  console.log("\n--- Memory Operations ---");
  const memoryJson = JSON.stringify({
    id: elizaos.generateUUID(),
    entityId: elizaos.generateUUID(),
    roomId: elizaos.generateUUID(),
    content: {
      text: "Hello from Bun!",
      source: "example",
    },
    createdAt: Date.now(),
  });

  const memory = elizaos.parseMemory(memoryJson);
  console.log(`Memory entity ID: ${memory.entityId}`);
  console.log(`Memory content: ${memory.content}`);

  // Round-trip test
  console.log("\n--- Round-Trip Test ---");
  const roundTripOk = elizaos.testMemoryRoundTrip(memoryJson);
  console.log(`Memory round-trip: ${roundTripOk ? "✓ PASS" : "✗ FAIL"}`);

  const charRoundTripOk = elizaos.testCharacterRoundTrip(characterJson);
  console.log(`Character round-trip: ${charRoundTripOk ? "✓ PASS" : "✗ FAIL"}`);

  console.log("\n=== Example Complete ===");
}

main().catch(console.error);

