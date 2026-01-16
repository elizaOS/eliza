import { createCharacter, type IAgentRuntime } from "@elizaos/core";
import type { JSONSchema7 } from "json-schema";
import { createMcpToolCompatibility, detectModelProvider } from "./index";

/**
 * Minimal mock runtime for testing model detection.
 * Extends IAgentRuntime with model information properties.
 */
interface MockRuntime extends IAgentRuntime {
  modelProvider?: string;
  model?: string;
}

/**
 * Creates a minimal mock runtime with model information for testing.
 */
function createMockRuntime(modelProvider: string, model: string): MockRuntime {
  const base: Partial<IAgentRuntime> = {
    agentId: "test-agent-id" as IAgentRuntime["agentId"],
    character: createCharacter({
      name: "Test Agent",
      bio: "Test",
      settings: {
        MODEL_PROVIDER: modelProvider,
        MODEL: model,
      },
    }),
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map(),
    events: {},
    routes: [],
    logger: {
      level: "info",
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      success: () => {},
      progress: () => {},
      log: () => {},
      clear: () => {},
      child: () => ({}) as IAgentRuntime["logger"],
    } as IAgentRuntime["logger"],
    stateCache: new Map(),
    messageService: null,
    initPromise: Promise.resolve(),
    getSetting: () => null,
    setSetting: () => {},
    getConversationLength: () => 0,
    registerPlugin: async () => {},
    initialize: async () => {},
    getConnection: async () => ({}),
    getService: () => null,
    getServicesByType: () => [],
    getAllServices: () => new Map(),
    registerService: async () => {},
    getServiceLoadPromise: async () => {
      throw new Error("Not implemented in mock");
    },
    getRegisteredServiceTypes: () => [],
    hasService: () => false,
    registerDatabaseAdapter: () => {},
  };

  return {
    ...base,
    modelProvider,
    model,
  } as MockRuntime;
}

// Example MCP tool schema with various constraints that cause problems
const problematicToolSchema: JSONSchema7 = {
  type: "object",
  properties: {
    email: {
      type: "string",
      format: "email", // Often rejected by OpenAI models
      minLength: 5,
      maxLength: 100,
    },
    url: {
      type: "string",
      format: "uri", // Commonly rejected by OpenAI o3-mini
      pattern: "^https?://", // Regex patterns ignored by Google models
    },
    age: {
      type: "number",
      minimum: 0,
      maximum: 150,
      multipleOf: 1, // Some models ignore this
    },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 1, // Google models often ignore
      maxItems: 10,
      uniqueItems: true, // Reasoning models ignore
    },
    metadata: {
      type: "object",
      minProperties: 1, // Often ignored
      maxProperties: 5,
      additionalProperties: false, // Widely ignored
    },
  },
  required: ["email", "url"],
};

// Test function to demonstrate the compatibility system
export async function demonstrateToolCompatibility() {
  console.log("=== MCP Tool Compatibility Demonstration ===\n");

  // Test with different mock runtimes (minimal mocks for testing purposes)
  const testRuntimes = [
    createMockRuntime("openai", "gpt-4"),
    createMockRuntime("openai", "o3-mini"), // Reasoning model
    createMockRuntime("anthropic", "claude-3"),
    createMockRuntime("google", "gemini-pro"),
    createMockRuntime("unknown", "some-other-model"),
  ];

  console.log("Original problematic schema:");
  console.log(JSON.stringify(problematicToolSchema, null, 2));
  console.log(`\n${"=".repeat(50)}\n`);

  for (const runtime of testRuntimes) {
    const mockRuntime = runtime as MockRuntime;
    const modelProvider = mockRuntime.modelProvider ?? "unknown";
    const model = mockRuntime.model ?? "unknown";
    console.log(`Testing with: ${modelProvider} - ${model}`);
    console.log("-".repeat(30));

    // Detect model info
    const modelInfo = detectModelProvider(runtime);
    console.log("Detected model info:", modelInfo);

    // Create compatibility layer
    const compatibility = await createMcpToolCompatibility(runtime);

    if (compatibility) {
      console.log("✅ Compatibility layer applied");

      // Transform the schema
      const transformedSchema = compatibility.transformToolSchema(problematicToolSchema);

      console.log("Transformed schema:");
      console.log(JSON.stringify(transformedSchema, null, 2));

      // Show what changed
      const changes = findSchemaChanges(problematicToolSchema, transformedSchema);
      if (changes.length > 0) {
        console.log("\nKey changes made:");
        for (const change of changes) {
          console.log(`  • ${change}`);
        }
      } else {
        console.log("\nNo changes needed for this model");
      }
    } else {
      console.log("❌ No compatibility layer needed");
    }

    console.log(`\n${"=".repeat(50)}\n`);
  }
}

// Helper function to identify what changed in the schema
function findSchemaChanges(original: JSONSchema7, transformed: JSONSchema7): string[] {
  const changes: string[] = [];

  if (original.properties && transformed.properties) {
    for (const [propName, origProp] of Object.entries(original.properties)) {
      const transProp = transformed.properties[propName];

      if (typeof origProp === "object" && typeof transProp === "object") {
        // Check for removed properties
        const origKeys = Object.keys(origProp);
        const transKeys = Object.keys(transProp);
        const removedKeys = origKeys.filter((key) => !transKeys.includes(key));

        if (removedKeys.length > 0) {
          changes.push(`${propName}: Removed unsupported properties: ${removedKeys.join(", ")}`);
        }

        // Check for description changes (indicating constraint embedding)
        if (origProp.description !== transProp.description && transProp.description) {
          if (
            transProp.description.includes("{") ||
            transProp.description.includes("Constraints:")
          ) {
            changes.push(`${propName}: Embedded constraints in description`);
          }
        }
      }
    }
  }

  return changes;
}

// Example of how to use in practice
export async function exampleUsage() {
  // In your MCP action, you would do something like this:
  const agentRuntime = createMockRuntime("openai", "o3-mini");
  const compatibility = await createMcpToolCompatibility(agentRuntime);

  // Original MCP tool schema from server
  const originalSchema: JSONSchema7 = {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      count: { type: "number", minimum: 1, maximum: 100 },
    },
  };

  // Apply compatibility if needed
  const finalSchema = compatibility
    ? compatibility.transformToolSchema(originalSchema)
    : originalSchema;

  console.log("Final schema for tool calling:", finalSchema);
  return finalSchema;
}
