# Context-Aware Test Generation for ElizaOS V2 Plugins

## 🎯 Overview

The **Context-Aware Test Generator** revolutionizes plugin testing by analyzing the actual plugin structure and generating **specific, meaningful tests** rather than using static templates.

## 🔍 How It Works

### 1. **Plugin Analysis Phase**
```typescript
interface PluginAnalysis {
  name: string;
  description: string;
  hasServices: boolean;      // ✅ Detected from src/
  hasActions: boolean;       // ✅ Detected from src/
  hasProviders: boolean;     // ✅ Detected from src/
  services: Array<{
    name: string;
    type: string;
    methods: string[];       // ✅ Extracted from code
  }>;
  actions: Array<{
    name: string;
    description: string;     // ✅ Extracted from code
    examples: string[];      // ✅ Extracted from code
    validate: boolean;       // ✅ Detected from code
    handler: boolean;        // ✅ Detected from code
  }>;
  apiKeys: string[];         // ✅ Extracted from code
}
```

### 2. **Dynamic Test Generation**
Based on the analysis, the system generates:

#### **If Services Found:**
```typescript
// Generates actual service tests
{
  name: "4. Service initialization and registration",
  fn: async (runtime: IAgentRuntime) => {
    const services = newsPlugin.services || [];
    
    for (const ServiceClass of services) {
      // Test actual service structure
      if (!ServiceClass.serviceType) {
        throw new Error("Service missing serviceType");
      }
      
      // Test actual service lifecycle
      const service = await ServiceClass.start(mockRuntime);
      await service.stop();
    }
  }
}
```

#### **If Actions Found:**
```typescript
// Generates tests for each action discovered
{
  name: "5. Action structure and validation", 
  fn: async (runtime: IAgentRuntime) => {
    const actions = newsPlugin.actions || [];
    
    for (const action of actions) {
      // Test each action's actual structure
      if (!action.name || !action.description) {
        throw new Error(`Action ${action.name} missing required fields`);
      }
      
      // Test actual validate/handler methods
      if (typeof action.validate !== 'function') {
        throw new Error(`Action ${action.name} missing validate method`);
      }
    }
  }
}
```

#### **If API Keys Found:**
```typescript
// Generates config tests with actual API keys
const validConfig = {
  NEWS_API_KEY: "test-key-12345",        // ✅ Detected from plugin
  COINGECKO_API_KEY: "test-key-12345",   // ✅ Detected from plugin
};
```

## 🚀 **Dynamic vs Static Comparison**

### ❌ **OLD: Static Template System**
```typescript
// Always generated the SAME tests regardless of plugin
export const test: TestSuite = {
  name: "Generic Plugin Tests",
  tests: [
    { name: "Plugin structure" },          // Generic
    { name: "Generic action test" },       // Generic
    { name: "Generic service test" },      // Generic
  ]
};
```

### ✅ **NEW: Context-Aware System**
```typescript
// For NEWS plugin - generates NEWS-specific tests
export class NewsPluginTestSuite implements TestSuite {
  name = "plugin-news";
  tests = [
    { name: "1. Plugin has complete V2 structure" },
    { name: "2. Plugin can be initialized" }, 
    { name: "3. Configuration validation" },
    { name: "4. Action structure and validation" },          // ✅ Only if has actions  
    { name: "5. Action execution and callbacks" },           // ✅ Only if has actions
    { name: "6. Memory operations" },
    { name: "7. Error handling and recovery" },
    { name: "8. Integration test - complete workflow" }
  ];
}

// For MCP plugin - generates MCP-specific tests  
export class McpPluginTestSuite implements TestSuite {
  name = "plugin-mcp";
  tests = [
    { name: "1. Plugin has complete V2 structure" },
    { name: "2. Plugin can be initialized" },
    { name: "3. Configuration validation" },
    { name: "4. Provider functionality" },                   // ✅ Only if has providers
    { name: "5. Memory operations" },
    { name: "6. Error handling and recovery" },
    { name: "7. Integration test - complete workflow" }
  ];
}
```

## 🔧 **Context Analysis Process**

### **Step 1: File Structure Analysis**
```typescript
// Scans src/ directory for:
const serviceFiles = await this.findFiles(srcDir, /service|Service/);
const actionFiles = await this.findFiles(srcDir, /action|Action/);  
const providerFiles = await this.findFiles(srcDir, /provider|Provider/);
```

### **Step 2: Code Content Analysis**
```typescript
// Extracts actual code features:
const hasValidate = content.includes('validate:') || content.includes('validate(');
const hasHandler = content.includes('handler:') || content.includes('handler(');

// Extracts descriptions from code:
const descMatch = content.match(/description:\s*['"](.*?)['"]/);

// Extracts API keys from code:
const apiKeyMatches = indexContent.match(/[A-Z_]+_API_KEY/g) || [];
```

### **Step 3: Method Extraction**
```typescript
// Finds actual methods in services:
const methodMatches = content.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/g);
```

## 📋 **Generated Test Categories**

### **Always Generated (Core V2 Tests):**
1. ✅ Plugin V2 structure validation
2. ✅ Plugin initialization  
3. ✅ Configuration validation
4. ✅ Memory operations
5. ✅ Error handling and recovery
6. ✅ Integration test

### **Conditionally Generated (Context-Based):**
7. 🎯 **Action tests** (only if actions detected)  
8. 🔍 **Provider tests** (only if providers detected)
9. ⚡ **Performance tests** (if complex operations detected)
10. 🔀 **Concurrency tests** (if multiple actions detected)

### **Skipped Tests:**
- 🔧 **Service initialization tests** (skipped to reduce complexity)

## 🎨 **Test Content Customization**

### **Plugin-Specific Variables:**
```typescript
// NEWS Plugin generates:
import newsPlugin from "../index.js";
const testMemory = {
  content: { source: "plugin-news" }  // ✅ Plugin-specific
};

// MCP Plugin generates:  
import mcpPlugin from "../index.js";
const testMemory = {
  content: { source: "plugin-mcp" }   // ✅ Plugin-specific
};
```

### **API Key Configuration:**
```typescript
// For NEWS plugin (auto-detected):
const validConfig = {
  NEWS_API_KEY: "test-key-12345"
};

// For CoinGecko plugin (auto-detected):
const validConfig = {
  COINGECKO_API_KEY: "test-key-12345"
};
```

## 🔄 **Iterative Testing & Fixing**

The system includes automatic iteration to ensure tests work:

1. **Generate Tests** → Analyze plugin structure
2. **Build Test** → Try npm run build  
3. **Fix Build Errors** → Auto-fix common issues
4. **Run Tests** → Try npm test
5. **Fix Test Errors** → Auto-fix runtime issues  
6. **Repeat** → Up to 3 iterations

## 📊 **Test Results**

```typescript
interface TestGenerationResult {
  success: boolean;           // Overall success
  message: string;           // Summary message
  testsGenerated: number;    // Number of test files created
  buildPassed: boolean;      // Build validation
  testsPassed: boolean;      // Test execution  
  iterations: number;        // Iterations needed
}
```

## 🎯 **Benefits**

### ✅ **Accuracy**
- Tests match actual plugin components
- No more generic/irrelevant tests
- Real validation of plugin features

### ✅ **Relevance**  
- Only tests what exists in the plugin
- Plugin-specific error scenarios
- Contextual test data

### ✅ **Maintainability**
- Tests evolve with plugin changes
- Clear test names and descriptions
- Progressive test dependencies

### ✅ **Reliability**
- Iterative fixing ensures tests run
- Build validation before test execution
- Graceful handling of missing features

## 🔧 **Usage**

```typescript
// In migration system:
const testGenerator = new ContextAwareTestGenerator(migrationContext);
const result = await testGenerator.generateTests();

if (result.success) {
  console.log(`✅ Generated ${result.testsGenerated} test files`);
  console.log(`✅ Build passed: ${result.buildPassed}`);  
  console.log(`✅ Tests passed: ${result.testsPassed}`);
  console.log(`🔄 Completed in ${result.iterations} iterations`);
}
```

## 🎨 **Example: NEWS Plugin Analysis**

```typescript
// Analysis Result:
{
  name: "plugin-news",
  description: "News fetching plugin for ElizaOS",
  hasServices: true,       // ✅ NewsService detected
  hasActions: true,        // ✅ getNews action detected  
  hasProviders: false,     // ❌ No providers found
  services: [{
    name: "NewsService",
    type: "typed",         // ✅ Has serviceType
    methods: ["start", "stop", "getNews"]  // ✅ Extracted from code
  }],
  actions: [{
    name: "getNews", 
    description: "Fetch latest news articles",  // ✅ From code
    examples: ["Get me tech news", "Latest news"],  // ✅ From code
    validate: true,        // ✅ validate() found
    handler: true          // ✅ handler() found
  }],
  apiKeys: ["NEWS_API_KEY"]  // ✅ Detected from code
}

// Generated Tests (8 total):
1. Plugin V2 structure validation
2. Plugin initialization
3. Configuration validation (with NEWS_API_KEY)
4. Action structure validation (getNews specific)  
5. Action execution (getNews specific)
6. Memory operations
7. Error handling (NEWS-specific scenarios)
8. Integration test (NEWS workflow)
```

This system ensures every plugin gets **exactly the tests it needs** based on its **actual structure and functionality**! 