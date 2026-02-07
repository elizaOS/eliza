#!/usr/bin/env bun
/**
 * Basic WASM Example
 *
 * Run with:
 *   bun run examples/wasm/basic.ts
 */

import * as elizaos from "../../pkg-node/elizaos.js";

async function main() {
  console.log("=== elizaOS WASM Basic Example ===\n");

  console.log(`Version: ${elizaos.getVersion()}`);

  console.log("\n--- UUID Operations ---");
  const uuid = elizaos.generateUUID();
  console.log(`Generated UUID: ${uuid}`);
  console.log(`Is valid: ${elizaos.validateUUID(uuid)}`);
  console.log(`Deterministic UUID: ${elizaos.stringToUuid("my-agent-name")}`);

  console.log("\n--- Character Parsing ---");
  const character = elizaos.parseCharacter(
    JSON.stringify({
      name: "BunAgent",
      bio: "A helpful agent running in Bun",
      system: "Be helpful and concise.",
    })
  );
  console.log(`Character name: ${character.name}`);

  console.log("\n--- Memory Round-Trip ---");
  const memory = elizaos.parseMemory(
    JSON.stringify({
      entityId: elizaos.generateUUID(),
      roomId: elizaos.generateUUID(),
      content: { text: "Hello from Bun!" },
    })
  );
  const memoryJson = memory.toJson();
  console.log(`Memory JSON: ${memoryJson}`);

  console.log("\n=== Example Complete ===");
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
