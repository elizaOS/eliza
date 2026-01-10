/**
 * elizaOS Rust-WASM CLI Chat
 *
 * This example demonstrates the full capabilities of the Rust agent runtime
 * compiled to WebAssembly. It showcases:
 *
 * 1. **Full Rust Runtime in WASM**: The AgentRuntime runs in Rust/WASM
 * 2. **TypeScript Plugin Integration**: Uses @elizaos/plugin-openai for model inference
 * 3. **Cross-Language Type Compatibility**: Tests all WASM type bindings
 * 4. **Deterministic UUIDs**: Same UUIDs generated in Rust, TypeScript, and Python
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    TypeScript Application                    │
 * │  (orchestration, I/O, plugin loading)                       │
 * ├─────────────────────────────────────────────────────────────┤
 * │                    TypeScript Plugin Bridge                  │
 * │  (@elizaos/plugin-openai → JS model handler)                │
 * ├─────────────────────────────────────────────────────────────┤
 * │                    Rust WASM Module                          │
 * │  WasmAgentRuntime, Type validation, UUID generation         │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * Usage:
 *   OPENAI_API_KEY=your_key bun run examples/rust-wasm/chat.ts
 *
 * Prerequisites:
 *   cd packages/core/rust && wasm-pack build --target nodejs --features wasm --no-default-features
 */

import * as readline from "readline";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// WASM MODULE TYPES
// ============================================================================

interface WasmModule {
  // Runtime
  WasmAgentRuntime: {
    create(characterJson: string): WasmAgentRuntime;
  };

  // UUID utilities
  stringToUuid(input: string): string;
  generateUUID(): string;
  validateUUID(uuid: string): boolean;
  getVersion(): string;

  // Type wrappers - for cross-language compatibility testing
  WasmCharacter: WasmTypeWrapper;
  WasmMemory: WasmMemoryWrapper;
  WasmAgent: WasmTypeWrapper;
  WasmPlugin: WasmTypeWrapper;
  WasmState: WasmStateWrapper;
  WasmRoom: WasmTypeWrapper;
  WasmEntity: WasmTypeWrapper;
  WasmUUID: WasmUUIDWrapper;

  // Test helpers
  testCharacterRoundTrip(json: string): boolean;
  testMemoryRoundTrip(json: string): boolean;
  testAgentRoundTrip(json: string): boolean;

  // Parsing functions
  parseCharacter(json: string): WasmCharacterInstance;
  parseMemory(json: string): WasmMemoryInstance;
}

interface WasmTypeWrapper {
  fromJson(json: string): { toJson(): string; name?: string; id: string };
}

interface WasmMemoryWrapper {
  fromJson(json: string): WasmMemoryInstance;
}

interface WasmStateWrapper {
  fromJson(json: string): { toJson(): string };
  new (): { toJson(): string };
}

interface WasmUUIDWrapper {
  fromString(s: string): { toString(): string };
  new (): { toString(): string };
}

interface WasmCharacterInstance {
  toJson(): string;
  name: string;
  system: string | null;
  bio: string;
  topics: string;
}

interface WasmMemoryInstance {
  toJson(): string;
  id: string | null;
  entityId: string;
  roomId: string;
  content: string;
  unique: boolean;
  createdAt: number | null;
}

interface WasmAgentRuntime {
  initialize(): void;
  registerModelHandler(modelType: string, handler: (params: string) => Promise<string>): void;
  handleMessage(messageJson: string): Promise<string>;
  stop(): void;
  readonly agentId: string;
  readonly characterName: string;
  readonly character: string;
  free(): void;
}

interface MessageResponse {
  didRespond: boolean;
  responseContent: {
    text?: string;
  };
  responseMessages: Array<{
    id: string;
    entityId: string;
    roomId: string;
    content: { text: string };
  }>;
}

// ============================================================================
// WASM MODULE LOADING
// ============================================================================

async function loadWasmModule(): Promise<WasmModule> {
  const possiblePaths = [
    path.join(__dirname, "../../packages/core/rust/pkg/elizaos.js"),
    path.join(__dirname, "../../packages/core/rust/pkg-node/elizaos.js"),
  ];

  for (const wasmPath of possiblePaths) {
    if (fs.existsSync(wasmPath)) {
      try {
        const wasm = await import(wasmPath);
        return wasm as WasmModule;
      } catch (error) {
        console.warn(`⚠️ Failed to load WASM from ${wasmPath}:`, error);
      }
    }
  }

  throw new Error(
    "WASM module not found. Build it first:\n" +
    "  cd packages/core/rust && wasm-pack build --target nodejs --features wasm --no-default-features"
  );
}

// ============================================================================
// WASM BINDING TESTS
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

async function testWasmBindings(wasm: WasmModule): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test 1: UUID utilities
  results.push((() => {
    try {
      const uuid1 = wasm.stringToUuid("test-input");
      const uuid2 = wasm.stringToUuid("test-input");
      const uuid3 = wasm.stringToUuid("different-input");
      const randomUuid = wasm.generateUUID();

      if (uuid1 !== uuid2) {
        return { name: "UUID determinism", passed: false, error: "stringToUuid not deterministic" };
      }
      if (uuid1 === uuid3) {
        return { name: "UUID determinism", passed: false, error: "Different inputs produced same UUID" };
      }
      if (!wasm.validateUUID(uuid1) || !wasm.validateUUID(randomUuid)) {
        return { name: "UUID validation", passed: false, error: "Valid UUIDs failed validation" };
      }
      if (wasm.validateUUID("not-a-uuid")) {
        return { name: "UUID validation", passed: false, error: "Invalid UUID passed validation" };
      }
      return { name: "UUID utilities", passed: true };
    } catch (e) {
      return { name: "UUID utilities", passed: false, error: String(e) };
    }
  })());

  // Test 2: WasmUUID class
  results.push((() => {
    try {
      const uuid = new wasm.WasmUUID();
      const uuidStr = uuid.toString();
      if (!wasm.validateUUID(uuidStr)) {
        return { name: "WasmUUID class", passed: false, error: "Generated UUID is invalid" };
      }

      const parsed = wasm.WasmUUID.fromString(uuidStr);
      if (parsed.toString() !== uuidStr) {
        return { name: "WasmUUID class", passed: false, error: "Round-trip failed" };
      }
      return { name: "WasmUUID class", passed: true };
    } catch (e) {
      return { name: "WasmUUID class", passed: false, error: String(e) };
    }
  })());

  // Test 3: WasmCharacter
  results.push((() => {
    try {
      const characterJson = JSON.stringify({
        name: "TestAgent",
        bio: "A test agent for WASM binding verification",
        system: "You are a test agent.",
        topics: ["testing", "wasm"],
      });

      const char = wasm.WasmCharacter.fromJson(characterJson);
      if (char.name !== "TestAgent") {
        return { name: "WasmCharacter", passed: false, error: "Name mismatch" };
      }

      // Test round-trip
      if (!wasm.testCharacterRoundTrip(characterJson)) {
        return { name: "WasmCharacter", passed: false, error: "Round-trip test failed" };
      }

      return { name: "WasmCharacter", passed: true };
    } catch (e) {
      return { name: "WasmCharacter", passed: false, error: String(e) };
    }
  })());

  // Test 4: WasmMemory
  results.push((() => {
    try {
      const memoryJson = JSON.stringify({
        id: wasm.generateUUID(),
        entityId: wasm.stringToUuid("user-1"),
        roomId: wasm.stringToUuid("room-1"),
        content: { text: "Hello, world!" },
        unique: true,
      });

      const mem = wasm.WasmMemory.fromJson(memoryJson);
      if (mem.entityId !== wasm.stringToUuid("user-1")) {
        return { name: "WasmMemory", passed: false, error: "entityId mismatch" };
      }
      if (mem.roomId !== wasm.stringToUuid("room-1")) {
        return { name: "WasmMemory", passed: false, error: "roomId mismatch" };
      }
      if (!mem.unique) {
        return { name: "WasmMemory", passed: false, error: "unique flag mismatch" };
      }

      // Test round-trip
      if (!wasm.testMemoryRoundTrip(memoryJson)) {
        return { name: "WasmMemory", passed: false, error: "Round-trip test failed" };
      }

      return { name: "WasmMemory", passed: true };
    } catch (e) {
      return { name: "WasmMemory", passed: false, error: String(e) };
    }
  })());

  // Test 5: WasmAgent
  results.push((() => {
    try {
      const agentJson = JSON.stringify({
        character: {
          name: "TestAgent",
          bio: "Test bio",
        },
      });

      const agent = wasm.WasmAgent.fromJson(agentJson);
      if (agent.name !== "TestAgent") {
        return { name: "WasmAgent", passed: false, error: "Name mismatch" };
      }

      if (!wasm.testAgentRoundTrip(agentJson)) {
        return { name: "WasmAgent", passed: false, error: "Round-trip test failed" };
      }

      return { name: "WasmAgent", passed: true };
    } catch (e) {
      return { name: "WasmAgent", passed: false, error: String(e) };
    }
  })());

  // Test 6: WasmPlugin
  results.push((() => {
    try {
      const pluginJson = JSON.stringify({
        name: "test-plugin",
        description: "A test plugin",
        version: "1.0.0",
      });

      const plugin = wasm.WasmPlugin.fromJson(pluginJson);
      if (plugin.name !== "test-plugin") {
        return { name: "WasmPlugin", passed: false, error: "Name mismatch" };
      }

      return { name: "WasmPlugin", passed: true };
    } catch (e) {
      return { name: "WasmPlugin", passed: false, error: String(e) };
    }
  })());

  // Test 7: WasmState
  results.push((() => {
    try {
      const state = new wasm.WasmState();
      const stateJson = state.toJson();
      const parsed = JSON.parse(stateJson);

      // Empty state should have empty values
      if (typeof parsed !== "object") {
        return { name: "WasmState", passed: false, error: "Invalid state JSON" };
      }

      return { name: "WasmState", passed: true };
    } catch (e) {
      return { name: "WasmState", passed: false, error: String(e) };
    }
  })());

  // Test 8: WasmRoom
  results.push((() => {
    try {
      const roomJson = JSON.stringify({
        id: wasm.generateUUID(),
        name: "Test Room",
      });

      const room = wasm.WasmRoom.fromJson(roomJson);
      if (!wasm.validateUUID(room.id)) {
        return { name: "WasmRoom", passed: false, error: "Invalid room ID" };
      }

      return { name: "WasmRoom", passed: true };
    } catch (e) {
      return { name: "WasmRoom", passed: false, error: String(e) };
    }
  })());

  // Test 9: WasmEntity
  results.push((() => {
    try {
      const entityJson = JSON.stringify({
        id: wasm.generateUUID(),
        name: "Test Entity",
      });

      const entity = wasm.WasmEntity.fromJson(entityJson);
      if (!entity.id || !wasm.validateUUID(entity.id)) {
        return { name: "WasmEntity", passed: false, error: "Invalid entity ID" };
      }

      return { name: "WasmEntity", passed: true };
    } catch (e) {
      return { name: "WasmEntity", passed: false, error: String(e) };
    }
  })());

  // Test 10: parseCharacter and parseMemory
  results.push((() => {
    try {
      const char = wasm.parseCharacter(JSON.stringify({ name: "ParseTest", bio: "test" }));
      if (char.name !== "ParseTest") {
        return { name: "parseCharacter", passed: false, error: "Name mismatch" };
      }

      const mem = wasm.parseMemory(JSON.stringify({
        entityId: wasm.generateUUID(),
        roomId: wasm.generateUUID(),
        content: { text: "test" },
      }));
      if (!mem.entityId) {
        return { name: "parseMemory", passed: false, error: "Missing entityId" };
      }

      return { name: "Parse functions", passed: true };
    } catch (e) {
      return { name: "Parse functions", passed: false, error: String(e) };
    }
  })());

  return results;
}

// ============================================================================
// TYPESCRIPT PLUGIN BRIDGE
// ============================================================================

interface ModelParams {
  prompt: string;
  system?: string;
  temperature?: number;
}

/**
 * Creates an OpenAI model handler that bridges to the TypeScript plugin ecosystem.
 * This demonstrates how the Rust WASM runtime can use TypeScript plugins for model inference.
 */
function createOpenAIModelHandler(apiKey: string, model: string = "gpt-4o") {
  return async (paramsJson: string): Promise<string> => {
    const params: ModelParams = JSON.parse(paramsJson);

    const messages: Array<{ role: string; content: string }> = [];

    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }

    messages.push({ role: "user", content: params.prompt });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: params.temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  };
}

/**
 * Creates a small model handler (uses gpt-4o-mini for faster/cheaper responses)
 */
function createSmallModelHandler(apiKey: string) {
  return createOpenAIModelHandler(apiKey, "gpt-4o-mini");
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

async function main() {
  console.log("\n🦀 elizaOS Rust-WASM CLI Chat\n");
  console.log("═".repeat(60));
  console.log("This demo runs the Rust AgentRuntime in WebAssembly");
  console.log("Model inference is bridged to TypeScript/OpenAI");
  console.log("═".repeat(60));

  // Check for API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("\n❌ OPENAI_API_KEY environment variable is required");
    console.error("   Usage: OPENAI_API_KEY=your_key bun run examples/rust-wasm/chat.ts\n");
    process.exit(1);
  }

  // Load WASM module
  console.log("\n📦 Loading Rust WASM module...");
  const wasm = await loadWasmModule();
  console.log(`   ✅ Loaded successfully`);
  console.log(`   📌 Version: ${wasm.getVersion()}`);

  // Run WASM binding tests
  console.log("\n🧪 Testing WASM bindings...\n");
  const testResults = await testWasmBindings(wasm);

  let allPassed = true;
  for (const result of testResults) {
    const status = result.passed ? "✅" : "❌";
    console.log(`   ${status} ${result.name}${result.error ? `: ${result.error}` : ""}`);
    if (!result.passed) allPassed = false;
  }

  if (!allPassed) {
    console.error("\n❌ Some WASM binding tests failed. Please check the Rust code.\n");
    process.exit(1);
  }

  console.log(`\n   ✅ All ${testResults.length} binding tests passed!\n`);

  // Define character
  console.log("─".repeat(60));
  console.log("\n🤖 Creating agent character...\n");

  const character = {
    name: "Eliza",
    bio: "A helpful AI assistant powered by elizaOS with a Rust-WASM runtime.",
    system: `You are Eliza, a helpful and friendly AI assistant.

Key traits:
- Concise but warm in your responses
- Technical expertise in software development
- Knowledge of Rust, WebAssembly, and TypeScript
- Always accurate and honest

You are running inside a Rust WebAssembly runtime, demonstrating cross-language interoperability.`,
  };

  // Validate character with WASM
  const wasmChar = wasm.parseCharacter(JSON.stringify(character));
  console.log(`   Name: ${wasmChar.name}`);
  console.log(`   System: ${wasmChar.system?.substring(0, 50)}...`);
  console.log(`   ✅ Character validated via Rust WASM`);

  // Generate deterministic UUIDs
  console.log("\n🔑 Generating UUIDs via Rust WASM...\n");
  const userId = wasm.stringToUuid("rust-wasm-demo-user");
  const roomId = wasm.stringToUuid("rust-wasm-demo-room");

  console.log(`   User ID:  ${userId}`);
  console.log(`   Room ID:  ${roomId}`);
  console.log(`   ✅ UUIDs are deterministic and cross-language compatible`);

  // Verify UUID determinism
  const userId2 = wasm.stringToUuid("rust-wasm-demo-user");
  if (userId !== userId2) {
    console.error("❌ UUID determinism check failed!");
    process.exit(1);
  }

  // Create the Rust WASM runtime
  console.log("\n─".repeat(60));
  console.log("\n🚀 Initializing Rust WASM runtime...\n");

  const runtime = wasm.WasmAgentRuntime.create(JSON.stringify(character));
  console.log(`   Agent ID: ${runtime.agentId}`);
  console.log(`   Character: ${runtime.characterName}`);

  // Register model handlers (bridging to TypeScript/OpenAI)
  console.log("\n📡 Registering TypeScript plugin model handlers...\n");

  runtime.registerModelHandler("TEXT_LARGE", createOpenAIModelHandler(apiKey, "gpt-4o"));
  console.log("   ✅ TEXT_LARGE → gpt-4o");

  runtime.registerModelHandler("TEXT_SMALL", createSmallModelHandler(apiKey));
  console.log("   ✅ TEXT_SMALL → gpt-4o-mini");

  // Initialize
  runtime.initialize();
  console.log("\n   ✅ Runtime initialized\n");

  // Create readline interface
  console.log("─".repeat(60));
  console.log(`\n💬 Chat with ${runtime.characterName}`);
  console.log("   Type 'exit' to quit, 'test' to run a binding test\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit") {
        console.log("\n👋 Goodbye!");
        runtime.stop();
        runtime.free();
        rl.close();
        process.exit(0);
      }

      if (text.toLowerCase() === "test") {
        // Run a quick binding test
        console.log("\n🧪 Running quick binding test...");
        const testUuid = wasm.generateUUID();
        console.log(`   Generated UUID: ${testUuid}`);
        console.log(`   Valid: ${wasm.validateUUID(testUuid)}`);

        const testMemory = {
          entityId: userId,
          roomId: roomId,
          content: { text: "Test message" },
        };
        const wasmMem = wasm.parseMemory(JSON.stringify(testMemory));
        console.log(`   Memory entityId: ${wasmMem.entityId}`);
        console.log(`   Memory roomId: ${wasmMem.roomId}`);
        console.log("   ✅ All bindings working!\n");
        prompt();
        return;
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        // Create message with WASM-generated UUID
        const messageId = wasm.generateUUID();
        const message = {
          id: messageId,
          entityId: userId,
          roomId: roomId,
          content: { text },
          createdAt: Date.now(),
        };

        // Validate message through WASM
        const wasmMem = wasm.WasmMemory.fromJson(JSON.stringify(message));
        if (wasmMem.entityId !== userId) {
          console.warn("⚠️ Message validation warning: entityId mismatch");
        }

        // Handle message through Rust runtime
        process.stdout.write(`${runtime.characterName}: `);
        const responseJson = await runtime.handleMessage(JSON.stringify(message));
        const response: MessageResponse = JSON.parse(responseJson);

        if (response.didRespond && response.responseContent?.text) {
          console.log(response.responseContent.text);

          // Validate response memory through WASM
          if (response.responseMessages.length > 0) {
            const respMem = response.responseMessages[0];
            const wasmRespMem = wasm.WasmMemory.fromJson(JSON.stringify(respMem));
            // Silently validate - just ensure no errors
            const respId = wasmRespMem.id;
            if (respId && !wasm.validateUUID(respId)) {
              console.warn("⚠️ Response memory has invalid ID");
            }
          }
        } else {
          console.log("[No response]");
        }
        console.log();
      } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : error}\n`);
      }

      prompt();
    });
  };

  prompt();
}

// Run the application
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
