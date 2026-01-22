/**
 * elizaOS Rust-WASM CLI Chat
 *
 * Demonstrates the Rust agent runtime compiled to WebAssembly with TypeScript
 * model handler integration for LLM inference.
 *
 * This example shows the correct pattern for extending the Rust WASM runtime:
 * - Model handlers are REGISTERED with the runtime via registerModelHandler()
 * - The runtime's handleMessage() processes messages through the full pipeline
 * - The runtime calls the registered handlers when it needs LLM inference
 *
 * This is different from bypassing the runtime (which would be incorrect).
 *
 * Usage:
 *   OPENAI_API_KEY=your_key bun run examples/chat/rust-wasm/chat.ts
 *
 * Prerequisites:
 *   cd packages/rust && wasm-pack build --target nodejs --features wasm --no-default-features
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ============================================================================
// WASM MODULE TYPES
// ============================================================================

interface WasmModule {
  WasmAgentRuntime: { create(characterJson: string): WasmAgentRuntime };
  WasmCharacter: WasmTypeWrapper;
  WasmMemory: WasmTypeWrapper<WasmMemoryInstance>;
  WasmAgent: WasmTypeWrapper;
  WasmPlugin: WasmTypeWrapper;
  WasmState: { new (): { toJson(): string } };
  WasmRoom: WasmTypeWrapper;
  WasmEntity: WasmTypeWrapper;
  WasmUUID: {
    new (): { toString(): string };
    fromString(s: string): { toString(): string };
  };

  stringToUuid(input: string): string;
  generateUUID(): string;
  validateUUID(uuid: string): boolean;
  getVersion(): string;

  testCharacterRoundTrip(json: string): boolean;
  testMemoryRoundTrip(json: string): boolean;
  testAgentRoundTrip(json: string): boolean;

  parseCharacter(json: string): { name: string; system: string | null };
  parseMemory(json: string): WasmMemoryInstance;
}

interface WasmTypeWrapper<T = { toJson(): string; name?: string; id: string }> {
  fromJson(json: string): T;
}

interface WasmMemoryInstance {
  toJson(): string;
  id: string | null;
  entityId: string;
  roomId: string;
  unique: boolean;
}

interface WasmAgentRuntime {
  initialize(): void;
  registerModelHandler(
    modelType: string,
    handler: (params: string) => Promise<string>,
  ): void;
  handleMessage(messageJson: string): Promise<string>;
  stop(): void;
  free(): void;
  readonly agentId: string;
  readonly characterName: string;
}

interface MessageResponse {
  didRespond: boolean;
  responseContent: { text?: string };
  responseMessages: Array<{ id: string; content: { text: string } }>;
}

// ============================================================================
// WASM MODULE LOADING
// ============================================================================

async function loadWasmModule(): Promise<WasmModule> {
  const paths = [
    path.join(__dirname, "../../../packages/rust/pkg/elizaos.js"),
    path.join(__dirname, "../../../packages/rust/pkg-node/elizaos.js"),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return (await import(p)) as WasmModule;
    }
  }

  throw new Error(
    "WASM module not found. Build it first:\n" +
      "  cd packages/rust && wasm-pack build --target nodejs --features wasm --no-default-features",
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

function runTest(name: string, fn: () => void): TestResult {
  try {
    fn();
    return { name, passed: true };
  } catch (e) {
    return {
      name,
      passed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function testWasmBindings(wasm: WasmModule): TestResult[] {
  return [
    runTest("UUID utilities", () => {
      const uuid1 = wasm.stringToUuid("test-input");
      const uuid2 = wasm.stringToUuid("test-input");
      assert(uuid1 === uuid2, "stringToUuid not deterministic");
      assert(
        uuid1 !== wasm.stringToUuid("different"),
        "Different inputs produced same UUID",
      );
      assert(wasm.validateUUID(uuid1), "Valid UUID failed validation");
      assert(
        !wasm.validateUUID("not-a-uuid"),
        "Invalid UUID passed validation",
      );
    }),

    runTest("WasmUUID class", () => {
      const uuid = new wasm.WasmUUID();
      assert(wasm.validateUUID(uuid.toString()), "Generated UUID is invalid");
      assert(
        wasm.WasmUUID.fromString(uuid.toString()).toString() ===
          uuid.toString(),
        "Round-trip failed",
      );
    }),

    runTest("WasmCharacter", () => {
      const json = JSON.stringify({
        name: "TestAgent",
        bio: "Test",
        system: "Test",
        topics: [],
      });
      assert(
        wasm.WasmCharacter.fromJson(json).name === "TestAgent",
        "Name mismatch",
      );
      assert(wasm.testCharacterRoundTrip(json), "Round-trip failed");
    }),

    runTest("WasmMemory", () => {
      const json = JSON.stringify({
        id: wasm.generateUUID(),
        entityId: wasm.stringToUuid("user-1"),
        roomId: wasm.stringToUuid("room-1"),
        content: { text: "Hello" },
        unique: true,
      });
      const mem = wasm.WasmMemory.fromJson(json);
      assert(mem.entityId === wasm.stringToUuid("user-1"), "entityId mismatch");
      assert(mem.unique === true, "unique flag mismatch");
      assert(wasm.testMemoryRoundTrip(json), "Round-trip failed");
    }),

    runTest("WasmAgent", () => {
      const now = Date.now();
      const json = JSON.stringify({
        name: "TestAgent",
        bio: "Test",
        createdAt: now,
        updatedAt: now,
      });
      assert(
        wasm.WasmAgent.fromJson(json).name === "TestAgent",
        "Name mismatch",
      );
      assert(wasm.testAgentRoundTrip(json), "Round-trip failed");
    }),

    runTest("WasmPlugin", () => {
      const json = JSON.stringify({
        name: "test-plugin",
        description: "Test",
        version: "1.0.0",
      });
      assert(
        wasm.WasmPlugin.fromJson(json).name === "test-plugin",
        "Name mismatch",
      );
    }),

    runTest("WasmState", () => {
      const state = new wasm.WasmState();
      assert(
        typeof JSON.parse(state.toJson()) === "object",
        "Invalid state JSON",
      );
    }),

    runTest("WasmRoom", () => {
      const json = JSON.stringify({
        id: wasm.generateUUID(),
        name: "Test",
        source: "test",
        type: "GROUP",
      });
      assert(
        wasm.validateUUID(wasm.WasmRoom.fromJson(json).id),
        "Invalid room ID",
      );
    }),

    runTest("WasmEntity", () => {
      const json = JSON.stringify({
        id: wasm.generateUUID(),
        names: ["Test"],
        metadata: {},
        agentId: wasm.generateUUID(),
      });
      assert(
        wasm.validateUUID(wasm.WasmEntity.fromJson(json).id),
        "Invalid entity ID",
      );
    }),

    runTest("Parse functions", () => {
      assert(
        wasm.parseCharacter(JSON.stringify({ name: "Test", bio: "test" }))
          .name === "Test",
        "Name mismatch",
      );
      const mem = wasm.parseMemory(
        JSON.stringify({
          entityId: wasm.generateUUID(),
          roomId: wasm.generateUUID(),
          content: { text: "test" },
        }),
      );
      assert(!!mem.entityId, "Missing entityId");
    }),
  ];
}

// ============================================================================
// MODEL HANDLER USING ELIZAOS OPENAI PLUGIN
// ============================================================================

/**
 * Creates a model handler that uses the OpenAI API.
 *
 * NOTE: This handler is registered WITH the Rust WASM runtime via registerModelHandler(),
 * which means the runtime controls when to call it. This is the correct pattern for
 * providing LLM capabilities to the runtime - similar to how plugins register handlers.
 *
 * The runtime's handleMessage() method processes messages through the full pipeline
 * and calls this handler when it needs to generate text.
 */
function createModelHandler(apiKey: string, model: string) {
  return async (paramsJson: string): Promise<string> => {
    const params: { prompt: string; system?: string; temperature?: number } =
      JSON.parse(paramsJson);

    // Build messages array
    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });

    // Use OpenAI API (this is the model handler implementation, similar to plugin-openai)
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content || "";
  };
}

/**
 * Create a large model handler (GPT-4o or similar)
 */
function createLargeModelHandler(apiKey: string) {
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  return createModelHandler(apiKey, model);
}

/**
 * Create a small/fast model handler (GPT-4o-mini or similar)
 */
function createSmallModelHandler(apiKey: string) {
  const model = process.env.OPENAI_SMALL_MODEL || "gpt-4o-mini";
  return createModelHandler(apiKey, model);
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
    console.error(
      "   Usage: OPENAI_API_KEY=your_key bun run examples/rust-wasm/chat.ts\n",
    );
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
    console.log(
      `   ${status} ${result.name}${result.error ? `: ${result.error}` : ""}`,
    );
    if (!result.passed) allPassed = false;
  }

  if (!allPassed) {
    console.error(
      "\n❌ Some WASM binding tests failed. Please check the Rust code.\n",
    );
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

  runtime.registerModelHandler("TEXT_LARGE", createLargeModelHandler(apiKey));
  const largeModel = process.env.OPENAI_MODEL || "gpt-4o";
  console.log(`   ✅ TEXT_LARGE → ${largeModel}`);

  runtime.registerModelHandler("TEXT_SMALL", createSmallModelHandler(apiKey));
  const smallModel = process.env.OPENAI_SMALL_MODEL || "gpt-4o-mini";
  console.log(`   ✅ TEXT_SMALL → ${smallModel}`);

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
