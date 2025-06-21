# ElizaOS Action Creator

Create Action component: $ARGUMENTS

## Action Specification
1. **Structure Requirements**
   - TypeScript interface with validation, handler, examples
   - Decision flow: Message → Validation → LLM → Handler → Response
   - Handler must include "thought" component

## Implementation Template
2. **Required Methods**
   - `validate(runtime, message)` - Boolean for availability
   - `handler(runtime, message)` - Execute and return response
   - `examples` - Usage patterns array
   - `name` - Action identifier
   - `similes` - Similar action names

3. **Code Template**
```typescript
import { Action } from "@elizaos/core";

export const actionName: Action = {
    name: "ACTION_NAME",
    similes: ["SIMILAR"],
    validate: async (runtime, message) => {
        // Validation logic
        return boolean;
    },
    handler: async (runtime, message) => {
        // Implementation
        return { text: "response", thought: "reasoning" };
    },
    examples: [/* Usage examples */]
};
```

## Integration & Testing
4. **Plugin Integration**
   - Add to plugin's actions array
   - Import in plugin index
   - Test with elizaos runtime

5. **Testing**
   - Unit tests for validation/handler
   - Integration tests
   - Run `elizaos test component`
