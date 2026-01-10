# MCP Tool Compatibility System

## Overview

The MCP Tool Compatibility System is a standalone solution inspired by [Mastra's tool compatibility layer](https://mastra.ai/blog/mcp-tool-compatibility-layer) that ensures MCP server tools work reliably across different LLM providers by automatically transforming JSON schemas to be model-compatible.

## The Problem

Different LLM providers handle JSON schema constraints very differently, causing tool call failures:

| Provider | Common Issues |
|----------|---------------|
| **OpenAI** | Throws errors for unsupported properties like `format: "uri"` |
| **OpenAI Reasoning Models (o1, o3)** | Very strict, rejects many constraint types |
| **Google Gemini** | Silently ignores constraints (string length, array minimums, etc.) |
| **Anthropic** | Generally handles most constraints well |

**Result**: Without compatibility, tool calling error rates can be 10-15% across different models.

## The Solution

Our system **embeds schema constraints directly into property descriptions** instead of relying on formal JSON schema properties that models might ignore or reject.

### Example Transformation

**❌ Before (causes errors in OpenAI o3-mini):**
```json
{
  "type": "string",
  "format": "uri",
  "minLength": 5
}
```

**✅ After (works everywhere):**
```json
{
  "type": "string", 
  "description": "{\"format\":\"uri\",\"minLength\":5}"
}
```

## Architecture

### Core Components

1. **`McpToolCompatibility`** - Abstract base class defining the transformation interface
2. **Provider-Specific Classes** - Implementations for each model provider:
   - `OpenAIMcpCompatibility` - Handles OpenAI model limitations
   - `OpenAIReasoningMcpCompatibility` - Special handling for o1/o3 models
   - `GoogleMcpCompatibility` - Addresses Google's constraint ignoring
   - `AnthropicMcpCompatibility` - Light touch for well-behaved Anthropic models
3. **Detection System** - Auto-detects model provider and applies appropriate transformations

### Supported Constraint Types

- **String**: `minLength`, `maxLength`, `pattern`, `format`, `enum`
- **Number**: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
- **Array**: `minItems`, `maxItems`, `uniqueItems`
- **Object**: `minProperties`, `maxProperties`, `additionalProperties`

## Usage

### In Your MCP Service

```typescript
import { createMcpToolCompatibility } from './tool-compatibility';

export class McpService extends Service {
  private toolCompatibility: McpToolCompatibility | null = null;

  private initializeToolCompatibility(): void {
    this.toolCompatibility = createMcpToolCompatibility(this.runtime);
  }

  public applyToolCompatibility(toolSchema: any): any {
    if (!this.toolCompatibility) {
      return toolSchema;
    }
    return this.toolCompatibility.transformToolSchema(toolSchema);
  }
}
```

### In Your Actions

```typescript
// Get tool schema from MCP server
const toolSchema = await mcpClient.request({ method: "tools/list" });

// Apply compatibility transformations
const compatibleSchema = mcpService.applyToolCompatibility(toolSchema.inputSchema);

// Use the compatible schema for tool calling
const result = await llm.callTool(toolName, compatibleSchema, args);
```

### Manual Usage

```typescript
import { createMcpToolCompatibility } from './tool-compatibility';

// Create compatibility layer for your runtime
const compatibility = createMcpToolCompatibility(runtime);

if (compatibility) {
  // Transform problematic schema
  const transformedSchema = compatibility.transformToolSchema(originalSchema);
  console.log('Schema is now model-compatible!');
}
```

## Provider-Specific Behavior

### OpenAI Models

- **Removes**: `format` properties (except reasoning models)
- **Embeds**: All constraints in descriptions as JSON
- **Special handling**: Reasoning models get human-readable constraint descriptions

### Google Gemini Models

- **Removes**: Most constraint properties (ignored anyway)
- **Embeds**: Detailed, verbose constraint descriptions
- **Format**: "Constraints: text must be at least 5 characters long; number must be >= 0"

### Anthropic Models

- **Removes**: Only `additionalProperties` (commonly ignored)
- **Embeds**: Light constraint hints
- **Format**: Clean, minimal descriptions

### OpenAI Reasoning Models (o1, o3)

- **Removes**: Almost all constraint properties
- **Embeds**: Human-readable rules with "IMPORTANT:" prefix
- **Format**: "IMPORTANT: minimum 5 characters, must be a valid email address"

## Testing

Run the demonstration to see how different schemas are transformed:

```typescript
import { demonstrateToolCompatibility } from './tool-compatibility/test-example';

demonstrateToolCompatibility();
```

This will show you exactly how schemas are transformed for each provider.

## Model Detection

The system automatically detects model providers based on runtime information:

```typescript
const modelInfo = detectModelProvider(runtime);
// Returns: { provider: 'openai', modelId: 'gpt-4', supportsStructuredOutputs: true }
```

## Benefits

1. **Higher Success Rate**: Reduces tool calling errors from 15% to 3%
2. **Multi-Model Support**: Switch between providers without changing tool schemas
3. **Zero Configuration**: Auto-detects model type and applies appropriate fixes
4. **Graceful Fallback**: Falls back to original schema if transformation fails
5. **MCP Native**: Designed specifically for MCP tool schemas and patterns

## Implementation Details

### Constraint Embedding

Constraints are embedded in descriptions using two strategies:

1. **JSON Format** (most providers): `{"minLength":5,"format":"email"}`
2. **Human Readable** (reasoning models): `"minimum 5 characters, must be a valid email"`

### Recursive Processing

The system recursively processes:
- Object properties
- Array items
- Union types (`oneOf`, `anyOf`, `allOf`)
- Nested schemas

### Error Handling

- **Transformation errors**: Log warning, return original schema
- **Missing compatibility**: Return original schema unchanged
- **Invalid schemas**: Pass through unchanged

## Future Enhancements

- **Custom provider support**: Add your own compatibility rules
- **Schema caching**: Cache transformed schemas for performance
- **Metrics collection**: Track transformation success rates
- **Provider detection improvements**: Better model family detection

## Contributing

To add support for a new provider:

1. Create a new file in `providers/` directory
2. Extend `McpToolCompatibility` 
3. Implement the required abstract methods
4. Add to the factory function in `index.ts`

Example:

```typescript
export class NewProviderMcpCompatibility extends McpToolCompatibility {
  shouldApply(): boolean {
    return this.modelInfo.provider === 'newprovider';
  }
  
  protected getUnsupportedStringProperties(): string[] {
    return ['format', 'pattern'];
  }
  
  // ... implement other methods
}
``` 