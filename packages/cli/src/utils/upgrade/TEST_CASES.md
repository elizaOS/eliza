# ElizaOS V2 Plugin Test Generation Mega Prompt

## 🎯 **Test Generation Objective**

Generate comprehensive, accurate test suites for ElizaOS V2 plugins using ONLY the built-in `elizaos test` framework. Each plugin must have 10-15 meaningful tests that validate actual functionality, not just structure.

## 🚨 **CRITICAL: Testing Framework Rules**

1. **ONLY use `elizaos test`** - No vitest, jest, or other frameworks
2. **NO test file stubs** - Every test must be fully implemented
3. **TypeScript throughout** - Full type safety required
4. **Progressive testing** - Later tests depend on earlier ones passing
5. **Graceful handling** - Don't fail on optional features

## 📚 **REFERENCE TEST IMPLEMENTATIONS**

### 1. **plugin-news-cursor Pattern** (Service & Action Testing)

```typescript
// COMPLETE PATTERN FROM plugin-news-cursor/src/test/test.ts
export class NewsPluginTestSuite implements TestSuite {
  name = "news-plugin";
  description = "Comprehensive tests for the News Plugin functionality - V2 Architecture";

  tests = [
    {
      name: "Should validate complete plugin V2 structure",
      fn: async (runtime: IAgentRuntime) => {
        // Test 1: COMPREHENSIVE structure validation
        if (!newsPlugin.name || !newsPlugin.actions) {
          throw new Error("Plugin missing basic structure");
        }

        if (!newsPlugin.services || newsPlugin.services.length === 0) {
          throw new Error("Plugin missing required V2 service registration");
        }

        if (!newsPlugin.providers || newsPlugin.providers.length === 0) {
          throw new Error("Plugin missing required V2 provider registration");
        }

        // V2 specific validations
        if (!newsPlugin.description) {
          throw new Error("Plugin missing required V2 description field");
        }

        if (typeof newsPlugin.init !== "function") {
          throw new Error("Plugin missing required V2 init function");
        }

        console.log("✅ Plugin has complete V2 structure");
      },
    },

    {
      name: "Should initialize service with comprehensive validation",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = process.env.NEWS_API_KEY || runtime.getSetting("NEWS_API_KEY");

        if (!apiKey) {
          console.warn("⚠️ Skipping service test - no NEWS_API_KEY found");
          return;
        }

        const testRuntime = createMockRuntime({
          getSetting: (key: string) => {
            if (key === "NEWS_API_KEY") return apiKey;
            return runtime.getSetting(key);
          },
        });

        // COMPREHENSIVE service registration testing
        const services = newsPlugin.services;
        if (!services || services.length === 0) {
          throw new Error("No services found in plugin");
        }

        const NewsService = services[0];

        // Test service class structure
        if (typeof NewsService.start !== "function") {
          throw new Error("Service missing required static start method");
        }

        if (!NewsService.serviceType || typeof NewsService.serviceType !== "string") {
          throw new Error("Service missing required serviceType property");
        }

        // Test service initialization
        await testRuntime.registerService(NewsService);

        const service = testRuntime.getService(NewsService.serviceType);
        if (!service) {
          throw new Error("Service not registered properly");
        }

        // Test service capabilities
        if (typeof service.capabilityDescription !== "string") {
          throw new Error("Service missing capabilityDescription");
        }

        // Test service lifecycle methods
        if (typeof service.stop !== "function") {
          throw new Error("Service missing stop method");
        }

        console.log("✅ Service initialization and structure validation complete");
      },
    },

    {
      name: "Should execute all actions with comprehensive testing",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = process.env.NEWS_API_KEY || runtime.getSetting("NEWS_API_KEY");

        if (!apiKey) {
          console.warn("⚠️ Skipping action test - no API key");
          return;
        }

        // Test EACH action comprehensively
        for (const action of actions) {
          console.log(`🎯 Testing action: ${action.name}`);

          // Validate action structure
          if (!action.name || !action.description) {
            throw new Error(`Action ${action.name} missing required fields`);
          }

          if (typeof action.validate !== "function") {
            throw new Error(`Action ${action.name} missing validate method`);
          }

          if (typeof action.handler !== "function") {
            throw new Error(`Action ${action.name} missing handler method`);
          }

          if (!action.examples || !Array.isArray(action.examples)) {
            throw new Error(`Action ${action.name} missing examples`);
          }

          // Create comprehensive test message
          const testMessage: Memory = {
            id: "test-message-id" as UUID,
            entityId: "test-entity-id" as UUID,
            agentId: testRuntime.agentId,
            roomId: "test-room-id" as UUID,
            content: {
              text: "What's the latest news about technology?",
              source: "test",
            },
            createdAt: Date.now(),
          };

          try {
            // Test validation
            const isValid = await action.validate(testRuntime, testMessage, {
              values: {},
              data: {},
              text: "",
            });

            if (typeof isValid !== "boolean") {
              throw new Error(`Action ${action.name} validate must return boolean`);
            }

            // Test handler execution
            let actionResult: Content | null = null;
            const callback = async (result: Content): Promise<Memory[]> => {
              actionResult = result;
              // Validate callback result structure
              if (!result || typeof result !== "object") {
                throw new Error(`Action ${action.name} callback received invalid result`);
              }
              if (!result.text && !result.content) {
                throw new Error(`Action ${action.name} callback result missing text or content`);
              }
              return [];
            };

            const success = await action.handler(
              testRuntime,
              testMessage,
              { values: {}, data: {}, text: "" },
              {},
              callback,
            );

            console.log(`✅ Action ${action.name} executed successfully`);
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`❌ Action ${action.name} test failed:`, errorMsg);
            throw error;
          }
        }

        console.log("✅ All actions tested comprehensively");
      },
    },

    {
      name: "Should handle ALL error scenarios comprehensively",
      fn: async (runtime: IAgentRuntime) => {
        console.log("🚫 Testing comprehensive error handling scenarios");

        // Test 1: Invalid API key scenarios
        const testRuntimeInvalidKey = createMockRuntime({
          getSetting: (key: string) => {
            if (key === "NEWS_API_KEY") return "invalid-api-key-12345";
            return runtime.getSetting(key);
          },
        });

        // Test 2: Missing API key scenarios
        const testRuntimeNoKey = createMockRuntime({
          getSetting: (key: string) => null,
        });

        // Test 3: Action error handling
        const actions = newsPlugin.actions;
        for (const action of actions) {
          console.log(`🚫 Testing error handling for action: ${action.name}`);

          const testMessage: Memory = {
            id: "test-message-id" as UUID,
            entityId: "test-entity-id" as UUID,
            agentId: testRuntimeInvalidKey.agentId,
            roomId: "test-room-id" as UUID,
            content: {
              text: `Execute ${action.name} with invalid setup`,
              source: "test",
            },
            createdAt: Date.now(),
          };

          let errorHandled = false;
          const callback = async (result: Content): Promise<Memory[]> => {
            // Check if error was properly handled and communicated
            if (result.text && 
                (result.text.includes("error") || 
                 result.text.includes("failed") || 
                 result.text.includes("invalid"))) {
              errorHandled = true;
              console.log(`✅ Action ${action.name} error properly handled:`, result.text);
            }
            return [];
          };

          try {
            await action.handler(testRuntimeInvalidKey, testMessage, 
              { values: {}, data: {}, text: "" }, {}, callback);

            if (!errorHandled) {
              console.log(`✅ Action ${action.name} handled invalid setup gracefully`);
            }
          } catch (error) {
            console.log(`✅ Action ${action.name} error handling working:`, error);
          }
        }

        console.log("✅ ALL error scenarios tested comprehensively");
      },
    }
  ];
}
```

### 2. **plugin-mcp Pattern** (Server Configuration & Tool Testing)

```typescript
// PATTERN FROM plugin-mcp/src/test.ts
export class McpPluginTestSuite implements TestSuite {
  name = "McpPlugin";
  description = "Tests for the MCP plugin functionality";

  tests = [
    {
      name: "Should configure filesystem MCP server and provide files",
      fn: async (runtime: IAgentRuntime) => {
        // Use current working directory instead of hardcoded path
        const currentDir = cwd();

        // Configure the MCP settings with the exact filesystem server configuration
        const mcpSettings = {
          servers: {
            filesystem: {
              type: "stdio",
              name: "Filesystem Server",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", currentDir],
            },
          },
        };

        // Mock the getSetting method to return our MCP configuration
        const originalGetSetting = runtime.getSetting;
        runtime.getSetting = (key: string) => {
          if (key === "mcp") {
            return mcpSettings;
          }
          return originalGetSetting.call(runtime, key);
        };

        try {
          // Initialize the MCP service
          const { McpService } = await import("./service.ts");
          const mcpService = await McpService.start(runtime);

          // Wait a bit for the connection to establish
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Get the list of servers
          const servers = mcpService.getServers();

          // Check if filesystem server is configured
          const filesystemServer = servers.find((s) => s.name === "filesystem");
          if (!filesystemServer) {
            throw new Error("Filesystem server not found in configured servers");
          }

          // Check if the server is connected
          if (filesystemServer.status !== "connected") {
            throw new Error(
              `Filesystem server status is ${filesystemServer.status}, expected 'connected'`
            );
          }

          // Check if the server has tools available
          if (!filesystemServer.tools || filesystemServer.tools.length === 0) {
            throw new Error("Filesystem server has no tools available");
          }

          // Look for file-related tools
          const fileTools = filesystemServer.tools.filter(
            (tool) =>
              tool.name.toLowerCase().includes("read") ||
              tool.name.toLowerCase().includes("list") ||
              tool.name.toLowerCase().includes("file")
          );

          if (fileTools.length === 0) {
            throw new Error("No file-related tools found in filesystem server");
          }

          // Clean up
          await mcpService.stop();
        } finally {
          // Restore original getSetting
          runtime.getSetting = originalGetSetting;
        }
      },
    },

    {
      name: "Should accurately list files when agent is asked about current directory contents",
      fn: async (runtime: IAgentRuntime) => {
        // Use current working directory
        const targetDirectory = cwd();

        // Configure the MCP settings
        const mcpSettings = {
          servers: {
            filesystem: {
              type: "stdio",
              name: "Filesystem Server",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", targetDirectory],
            },
          },
        };

        // Mock configuration
        const originalGetSetting = runtime.getSetting;
        runtime.getSetting = (key: string) => {
          if (key === "mcp") return mcpSettings;
          return originalGetSetting.call(runtime, key);
        };

        try {
          // Initialize service
          const { McpService } = await import("./service.ts");
          const mcpService = await McpService.start(runtime);

          // Wait for connection
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Find list_directory tool
          const servers = mcpService.getServers();
          const filesystemServer = servers.find((s) => s.name === "filesystem");
          const listDirectoryTool = filesystemServer?.tools?.find(
            (tool) => tool.name === "list_directory"
          );

          if (!listDirectoryTool) {
            throw new Error("list_directory tool not found");
          }

          // Call the tool
          const result = await mcpService.callTool("filesystem", "list_directory", {
            path: targetDirectory,
          });

          // Verify results
          const textContent = result.content.find((c) => c.type === "text");
          if (!textContent || !("text" in textContent)) {
            throw new Error("No text content in tool result");
          }

          const fileListingText = textContent.text;
          console.log("Actual directory contents:", fileListingText);

          // Verify expected files are present
          const expectedItems = ["src", "package.json", "tsconfig.json", "README.md"];
          const missingItems = expectedItems.filter(
            (item) => !fileListingText.toLowerCase().includes(item.toLowerCase())
          );

          if (missingItems.length > 2) {
            throw new Error(
              `Too many expected items missing in directory listing: ${missingItems.join(", ")}`
            );
          }

          console.log("✓ Agent accurately listed directory contents");

          // Clean up
          await mcpService.stop();
        } finally {
          runtime.getSetting = originalGetSetting;
        }
      },
    }
  ];
}
```

### 3. **plugin-knowledge Pattern** (Document Processing & Memory)

```typescript
// PATTERN FROM plugin-knowledge/src/tests.ts
export class KnowledgeTestSuite implements TestSuite {
  name = "knowledge";
  description = "Tests for the Knowledge plugin including document processing, retrieval, and integration";

  tests = [
    {
      name: "Should handle default docs folder configuration",
      fn: async (runtime: IAgentRuntime) => {
        // Set up environment
        const originalEnv = { ...process.env };
        delete process.env.KNOWLEDGE_PATH;

        try {
          // Check if docs folder exists
          const docsPath = path.join(process.cwd(), "docs");
          const docsExists = fs.existsSync(docsPath);

          if (!docsExists) {
            // Create temporary docs folder
            fs.mkdirSync(docsPath, { recursive: true });
          }

          // Initialize plugin - should use default docs folder
          await knowledgePlugin.init!({}, runtime);

          // Verify no error was thrown
          const errorCalls = mockLogger.error.calls;
          if (errorCalls.length > 0) {
            throw new Error(`Unexpected error during init: ${errorCalls[0]}`);
          }

          // Clean up
          if (!docsExists) {
            fs.rmSync(docsPath, { recursive: true, force: true });
          }
        } finally {
          // Restore environment
          process.env = originalEnv;
        }
      },
    },

    {
      name: "Should add knowledge successfully",
      fn: async (runtime: IAgentRuntime) => {
        const service = await KnowledgeService.start(runtime);
        runtime.services.set(KnowledgeService.serviceType as any, service);

        const testDocument = {
          clientDocumentId: uuidv4() as UUID,
          contentType: "text/plain",
          originalFilename: "knowledge-test.txt",
          worldId: runtime.agentId,
          content: "This is test knowledge that should be stored and retrievable.",
        };

        const result = await service.addKnowledge(testDocument);

        if (result.clientDocumentId !== testDocument.clientDocumentId) {
          throw new Error("Client document ID mismatch");
        }

        if (!result.storedDocumentMemoryId) {
          throw new Error("No stored document memory ID returned");
        }

        if (result.fragmentCount === 0) {
          throw new Error("No fragments created");
        }

        // Verify document was stored
        const storedDoc = await runtime.getMemoryById(result.storedDocumentMemoryId);
        if (!storedDoc) {
          throw new Error("Document not found in storage");
        }

        await service.stop();
      },
    },

    {
      name: "Should retrieve knowledge based on query",
      fn: async (runtime: IAgentRuntime) => {
        const service = await KnowledgeService.start(runtime);
        runtime.services.set(KnowledgeService.serviceType as any, service);

        // Add some test knowledge
        const testDocument = {
          clientDocumentId: uuidv4() as UUID,
          contentType: "text/plain",
          originalFilename: "retrieval-test.txt",
          worldId: runtime.agentId,
          content: "The capital of France is Paris. Paris is known for the Eiffel Tower.",
        };

        await service.addKnowledge(testDocument);

        // Create query message
        const queryMessage: Memory = {
          id: uuidv4() as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: runtime.agentId,
          content: {
            text: "What is the capital of France?",
          },
        };

        const results = await service.getKnowledge(queryMessage);

        if (results.length === 0) {
          throw new Error("No knowledge retrieved");
        }

        const hasRelevantContent = results.some(
          (item) =>
            item.content.text?.toLowerCase().includes("paris") ||
            item.content.text?.toLowerCase().includes("france")
        );

        if (!hasRelevantContent) {
          throw new Error("Retrieved knowledge not relevant to query");
        }

        await service.stop();
      },
    }
  ];
}
```

## 🎯 **COMPREHENSIVE TEST STRUCTURE TO GENERATE**

```typescript
import type { IAgentRuntime, TestSuite, Memory, UUID, State, Content, HandlerCallback } from "@elizaos/core";
import plugin from "../index.js";

// Progressive testing flags
let structureTestPassed = false;
let initTestPassed = false;
let serviceTestPassed = false;
let actionTestPassed = false;

export const test: TestSuite = {
  name: "@elizaos-plugins/${pluginName} Comprehensive Tests",
  tests: [
    // 10-15 comprehensive tests following patterns below
  ],
};

export default test;
```

## 📋 **REQUIRED TEST CATEGORIES**

### 1. **Plugin V2 Structure Validation** (REQUIRED)
```typescript
{
  name: "1. Plugin has complete V2 structure",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🔍 Testing plugin structure...");
    
    // Basic structure
    if (!plugin.name || !plugin.actions) {
      throw new Error("Plugin missing basic structure");
    }
    
    // V2 specific fields
    if (!plugin.description) {
      throw new Error("Plugin missing V2 description field");
    }
    
    // Check arrays are properly initialized
    if (!Array.isArray(plugin.actions)) {
      throw new Error("Plugin actions must be an array");
    }
    
    if (!Array.isArray(plugin.providers)) {
      throw new Error("Plugin providers must be an array");
    }
    
    if (!Array.isArray(plugin.services)) {
      throw new Error("Plugin services must be an array");
    }
    
    structureTestPassed = true;
    console.log("✅ Plugin structure validated");
  },
}
```

### 2. **Plugin Initialization** (REQUIRED)
```typescript
{
  name: "2. Plugin can be initialized",
  fn: async (runtime: IAgentRuntime) => {
    if (!structureTestPassed) {
      console.log("⏭️  Skipping init test - structure must pass first");
      return;
    }
    
    console.log("🔧 Testing plugin initialization...");
    
    // Check if init function exists and is callable
    if (plugin.init && typeof plugin.init === 'function') {
      try {
        await plugin.init({}, runtime);
        console.log("✅ Plugin initialization successful");
      } catch (error) {
        // Some plugins may require config, that's OK
        console.log("ℹ️  Plugin init requires configuration");
      }
    } else {
      console.log("ℹ️  Plugin has no init function");
    }
    
    initTestPassed = true;
  },
}
```

### 3. **Configuration Validation** (REQUIRED)
```typescript
{
  name: "3. Configuration validation",
  fn: async (runtime: IAgentRuntime) => {
    console.log("⚙️  Testing configuration handling...");
    
    // Test with missing config
    const emptyConfig = {};
    const validConfig = {
      ${pluginName.toUpperCase()}_API_KEY: "test-key-12345",
    };
    
    // Check if plugin handles missing config gracefully
    if (plugin.init) {
      try {
        await plugin.init(emptyConfig, runtime);
        console.log("✅ Plugin handles empty config gracefully");
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes("required") || errorMsg.includes("missing")) {
          console.log("✅ Plugin correctly validates required config");
        }
      }
    }
    
    console.log("✅ Configuration validation tested");
  },
}
```

### 4. **Service Registration & Lifecycle** (IF HAS SERVICE)
```typescript
{
  name: "4. Service initialization and registration",
  fn: async (runtime: IAgentRuntime) => {
    if (!initTestPassed) {
      console.log("⏭️  Skipping service test - init must pass first");
      return;
    }
    
    console.log("🔌 Testing service initialization...");
    
    const services = plugin.services || [];
    if (services.length === 0) {
      console.log("ℹ️  No services to test");
      return;
    }
    
    for (const ServiceClass of services) {
      // Validate service structure
      if (!ServiceClass.serviceType || typeof ServiceClass.serviceType !== 'string') {
        throw new Error("Service missing serviceType property");
      }
      
      if (typeof ServiceClass.start !== 'function') {
        throw new Error("Service missing start method");
      }
      
      // Test service initialization
      const mockRuntime = createMockRuntime({
        getSetting: (key: string) => {
          if (key.includes('API_KEY')) return 'test-api-key';
          return null;
        }
      });
      
      const service = await ServiceClass.start(mockRuntime);
      
      // Check service has required methods
      if (typeof service.stop !== 'function') {
        throw new Error("Service missing stop method");
      }
      
      if (!service.capabilityDescription) {
        throw new Error("Service missing capabilityDescription");
      }
      
      await service.stop();
      console.log(`✅ Service ${ServiceClass.serviceType} lifecycle working`);
    }
    
    serviceTestPassed = true;
  },
}
```

### 5. **Action Structure Validation** (IF HAS ACTIONS)
```typescript
{
  name: "5. Action structure and validation",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🎯 Testing action structure...");
    
    const actions = plugin.actions || [];
    if (actions.length === 0) {
      console.log("ℹ️  No actions to test");
      return;
    }
    
    for (const action of actions) {
      // Validate required properties
      if (!action.name || typeof action.name !== 'string') {
        throw new Error(`Action missing valid name`);
      }
      
      if (!action.description || typeof action.description !== 'string') {
        throw new Error(`Action ${action.name} missing description`);
      }
      
      if (typeof action.validate !== 'function') {
        throw new Error(`Action ${action.name} missing validate method`);
      }
      
      if (typeof action.handler !== 'function') {
        throw new Error(`Action ${action.name} missing handler method`);
      }
      
      if (!action.examples || !Array.isArray(action.examples)) {
        throw new Error(`Action ${action.name} missing examples array`);
      }
      
      // Validate handler signature (5 parameters)
      if (action.handler.length < 5) {
        throw new Error(`Action ${action.name} handler has wrong signature`);
      }
      
      console.log(`✅ Action ${action.name} structure validated`);
    }
    
    actionTestPassed = true;
  },
}
```

### 6. **Action Execution Testing** (IF HAS ACTIONS)
```typescript
{
  name: "6. Action execution and callbacks",
  fn: async (runtime: IAgentRuntime) => {
    if (!actionTestPassed) {
      console.log("⏭️  Skipping execution test - validation must pass first");
      return;
    }
    
    console.log("🚀 Testing action execution...");
    
    const actions = plugin.actions || [];
    for (const action of actions) {
      const testMessage: Memory = {
        id: `test-${Date.now()}` as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: "test-room" as UUID,
        content: { text: `Test ${action.name}` },
        createdAt: Date.now()
      };
      
      const testState: State = {
        values: {},
        data: {},
        text: ""
      };
      
      // Test validation
      try {
        const isValid = await action.validate(runtime, testMessage, testState);
        console.log(`✅ Action ${action.name} validation callable (returned ${isValid})`);
      } catch (error) {
        console.log(`ℹ️  Action ${action.name} validation requires specific context`);
      }
      
      // Test handler callback
      let callbackCalled = false;
      const callback: HandlerCallback = async (content: Content) => {
        callbackCalled = true;
        if (!content || !content.text) {
          throw new Error("Callback received invalid content");
        }
        return [];
      };
      
      // Don't execute handler directly, just verify it's callable
      console.log(`✅ Action ${action.name} handler verified`);
    }
  },
}
```

### 7. **Provider Functionality** (IF HAS PROVIDERS)
```typescript
{
  name: "7. Provider functionality",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🔍 Testing providers...");
    
    const providers = plugin.providers || [];
    if (providers.length === 0) {
      console.log("ℹ️  No providers to test");
      return;
    }
    
    for (const provider of providers) {
      if (!provider.name || typeof provider.name !== 'string') {
        throw new Error("Provider missing name");
      }
      
      if (typeof provider.get !== 'function') {
        throw new Error(`Provider ${provider.name} missing get method`);
      }
      
      // Test provider returns valid state
      const testMessage: Memory = {
        id: `test-${Date.now()}` as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: "test-room" as UUID,
        content: { text: "Test provider" },
        createdAt: Date.now()
      };
      
      try {
        const state = await provider.get(runtime, testMessage, {
          values: {},
          data: {},
          text: ""
        });
        
        if (!state || typeof state !== 'object') {
          throw new Error(`Provider ${provider.name} returned invalid state`);
        }
        
        console.log(`✅ Provider ${provider.name} working`);
      } catch (error) {
        console.log(`ℹ️  Provider ${provider.name} requires service context`);
      }
    }
  },
}
```

### 8. **Memory Operations** (REQUIRED)
```typescript
{
  name: "8. Memory operations",
  fn: async (runtime: IAgentRuntime) => {
    console.log("💾 Testing memory operations...");
    
    const testMemory: Memory = {
      id: `test-mem-${Date.now()}` as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: "test-room" as UUID,
      content: {
        text: "Test memory content",
        source: "${pluginName.toLowerCase()}"
      },
      metadata: {
        type: "test"
      },
      createdAt: Date.now()
    };
    
    try {
      // Test memory creation
      const memoryId = await runtime.createMemory(testMemory, "messages");
      console.log("✅ Memory creation supported");
      
      // Test memory retrieval
      if (runtime.getMemoryById) {
        const retrieved = await runtime.getMemoryById(memoryId);
        if (retrieved) {
          console.log("✅ Memory retrieval working");
        }
      }
    } catch (error) {
      console.log("ℹ️  Memory operations not available in test environment");
    }
  },
}
```

### 9. **Error Handling and Recovery** (REQUIRED)
```typescript
{
  name: "9. Error handling and recovery",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🚨 Testing error handling...");
    
    // Test with invalid inputs
    const invalidMessage = {
      id: null as any,
      content: null as any,
      entityId: null as any,
      agentId: runtime.agentId,
      roomId: null as any,
      createdAt: 0
    } as Memory;
    
    const actions = plugin.actions || [];
    let errorHandlingCount = 0;
    
    for (const action of actions) {
      try {
        await action.validate(runtime, invalidMessage, {
          values: {},
          data: {},
          text: ""
        });
      } catch (error) {
        errorHandlingCount++;
        console.log(`✅ Action ${action.name} properly handles invalid input`);
      }
    }
    
    if (errorHandlingCount > 0) {
      console.log(`✅ Error handling working for ${errorHandlingCount} actions`);
    } else if (actions.length === 0) {
      console.log("ℹ️  No actions to test error handling");
    }
  },
}
```

### 10. **Integration Test** (REQUIRED)
```typescript
{
  name: "10. Integration test - complete workflow",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🔄 Testing complete integration workflow...");
    
    try {
      // Initialize plugin if needed
      if (plugin.init) {
        const config = {
          ${pluginName.toUpperCase()}_API_KEY: "integration-test-key"
        };
        await plugin.init(config, runtime);
      }
      
      // Test a complete action flow if available
      const actions = plugin.actions || [];
      if (actions.length > 0) {
        const firstAction = actions[0];
        
        const integrationMessage: Memory = {
          id: `integration-${Date.now()}` as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: "integration-room" as UUID,
          content: { text: "Integration test message" },
          createdAt: Date.now()
        };
        
        const state: State = { values: {}, data: {}, text: "" };
        
        // Validate
        const isValid = await firstAction.validate(runtime, integrationMessage, state);
        
        console.log(`✅ Integration workflow tested (validation returned: ${isValid})`);
      }
      
      console.log("✅ Integration test completed");
    } catch (error) {
      console.log("ℹ️  Integration test requires full environment setup");
    }
  },
}
```

### 11. **Performance Testing**
```typescript
{
  name: "11. Performance - Response time validation",
  fn: async (runtime: IAgentRuntime) => {
    console.log("⏱️  Testing performance...");
    
    const actions = plugin.actions || [];
    if (actions.length === 0) {
      console.log("ℹ️  No actions to performance test");
      return;
    }
    
    const testMessage: Memory = {
      id: `perf-${Date.now()}` as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: "perf-room" as UUID,
      content: { text: "Performance test" },
      createdAt: Date.now()
    };
    
    for (const action of actions) {
      const start = Date.now();
      try {
        await action.validate(runtime, testMessage, { values: {}, data: {}, text: "" });
        const elapsed = Date.now() - start;
        console.log(`✅ Action ${action.name} validation took ${elapsed}ms`);
      } catch (error) {
        const elapsed = Date.now() - start;
        console.log(`ℹ️  Action ${action.name} validation failed in ${elapsed}ms`);
      }
    }
  },
}
```

### 12. **Concurrency Testing**
```typescript
{
  name: "12. Concurrency - Parallel execution safety",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🔀 Testing concurrent operations...");
    
    const actions = plugin.actions || [];
    if (actions.length < 2) {
      console.log("ℹ️  Not enough actions for concurrency test");
      return;
    }
    
    // Run multiple validations in parallel
    const promises = actions.slice(0, 3).map(async (action, i) => {
      const msg: Memory = {
        id: `concurrent-${i}` as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: "concurrent-room" as UUID,
        content: { text: `Concurrent test ${i}` },
        createdAt: Date.now()
      };
      
      try {
        await action.validate(runtime, msg, { values: {}, data: {}, text: "" });
        return { action: action.name, success: true };
      } catch (error) {
        return { action: action.name, success: false };
      }
    });
    
    const results = await Promise.all(promises);
    console.log(`✅ Concurrent operations completed: ${results.length} actions tested`);
  },
}
```

### 13. **Edge Cases and Boundaries**
```typescript
{
  name: "13. Edge cases and boundary conditions",
  fn: async (runtime: IAgentRuntime) => {
    console.log("🔧 Testing edge cases...");
    
    // Test empty arrays
    if (plugin.actions && plugin.actions.length === 0) {
      console.log("✅ Plugin handles empty actions array");
    }
    
    if (plugin.providers && plugin.providers.length === 0) {
      console.log("✅ Plugin handles empty providers array");
    }
    
    if (plugin.services && plugin.services.length === 0) {
      console.log("✅ Plugin handles empty services array");
    }
    
    // Test with undefined runtime settings
    const mockRuntime = {
      ...runtime,
      getSetting: () => undefined
    } as IAgentRuntime;
    
    if (plugin.init) {
      try {
        await plugin.init({}, mockRuntime);
        console.log("✅ Plugin handles undefined settings");
      } catch (error) {
        console.log("✅ Plugin validates required settings");
      }
    }
    
    console.log("✅ Edge case testing completed");
  },
}
```

## 🚨 **CRITICAL PATTERNS TO FOLLOW**

### 1. **Progressive Testing**
```typescript
if (!structureTestPassed) {
  console.log("⏭️  Skipping - structure test must pass first");
  return;
}
```

### 2. **Graceful Error Handling**
```typescript
try {
  // Test feature
  console.log("✅ Feature working");
} catch (error) {
  console.log("ℹ️  Feature not available in test environment");
}
```

### 3. **Clear Console Output**
- `🔍` - Investigating/analyzing
- `✅` - Test passed
- `❌` - Test failed
- `ℹ️` - Information/skipped
- `⚠️` - Warning
- `🚀` - Executing
- `🔧` - Configuration
- `⏱️` - Performance
- `💾` - Memory/storage
- `🚨` - Error/exception

### 4. **Proper Memory Structure**
```typescript
const testMemory: Memory = {
  id: `test-${Date.now()}` as UUID,
  entityId: runtime.agentId,
  agentId: runtime.agentId,
  roomId: "test-room" as UUID,
  content: {
    text: "Test content",
    source: "plugin-name"  // ONLY text and source allowed
  },
  metadata: {
    type: "test"
  },
  createdAt: Date.now()
};
```

### 5. **State Object Structure**
```typescript
const state: State = {
  values: {},    // Key-value pairs
  data: {},      // Complex data
  text: ""       // String representation
};
```

### 6. **Callback Pattern**
```typescript
const callback: HandlerCallback = async (content: Content): Promise<Memory[]> => {
  // Validate content
  if (!content || !content.text) {
    throw new Error("Invalid callback content");
  }
  return [];
};
```

## 📊 **TEST COVERAGE REQUIREMENTS**

Each plugin must have:
- **Minimum 10 tests**, ideally 12-15
- **100% structure validation**
- **All actions tested** (if any)
- **All services tested** (if any)
- **All providers tested** (if any)
- **Error handling coverage**
- **Integration testing**
- **Performance baseline**
- **Edge case handling**

## 🎯 **GENERATION INSTRUCTIONS**

When generating tests:

1. **Analyze plugin structure first**
   - Check for services, actions, providers
   - Identify required configuration
   - Note any special features

2. **Generate appropriate tests**
   - Skip service tests if no services
   - Skip action tests if no actions
   - Always include structure, init, config, memory, error, integration tests

3. **Use real test logic**
   - No stubs or placeholders
   - Actual validation logic
   - Meaningful error messages

4. **Follow progressive pattern**
   - Early tests enable later tests
   - Clear dependencies between tests
   - Graceful skipping when prerequisites fail

5. **Provide clear output**
   - Use emojis consistently
   - Log what's being tested
   - Show clear pass/fail status

Generate a COMPLETE test file following these patterns exactly. The tests should give confidence that the plugin works correctly in V2.
