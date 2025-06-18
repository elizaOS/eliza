# REPLY Action Implementation Example Is Outdated

## 📝 Priority: Medium

## 📋 Issue Summary

The REPLY action implementation example in the documentation doesn't match the actual implementation, showing simplified code that doesn't represent the real complexity and patterns used in the codebase.

## 🐛 Problem Description

### Documented REPLY Action (Simplified/Incorrect)
*File: `/packages/docs/docs/core/actions.md` lines 171-216*

```typescript
const replyAction: Action = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description: 'Replies to the current conversation with the text from the generated message.',

  validate: async (_runtime: IAgentRuntime) => true, // Always valid

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    // Compose state with necessary providers
    state = await runtime.composeState(message, [
      ...(message.content.providers ?? []),
      'RECENT_MESSAGES',
    ]);

    // Generate response using LLM
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: composePromptFromState({
        state,
        template: replyTemplate,
      }),
    });

    // Parse and format response
    const responseContentObj = parseJSONObjectFromText(response);
    const responseContent = {
      thought: responseContentObj.thought,
      text: responseContentObj.message || '',
      actions: ['REPLY'],
    };

    // Send response via callback
    await callback(responseContent);
    return true;
  },

  examples: [
    /* Examples omitted for brevity */
  ],
};
```

### Actual REPLY Action Implementation
*File: `/packages/plugin-bootstrap/src/actions/reply.ts`*

#### **Key Differences Found:**

1. **Model Type**: 
   - Documented: `ModelType.TEXT_SMALL`
   - Actual: `ModelType.OBJECT_LARGE`

2. **Provider Handling**:
   - Documented: Simple array spread
   - Actual: Complex provider collection from responses

3. **Error Handling**:
   - Documented: None
   - Actual: Comprehensive try-catch with fallbacks

4. **Response Structure**:
   - Documented: Simple object construction
   - Actual: Structured JSON parsing with validation

5. **State Composition**:
   - Documented: Basic provider array
   - Actual: Advanced provider collection from multiple sources

### Actual Implementation Highlights

```typescript
// Complex provider handling
const allProviders = [
  ...new Set([
    ...(message.content.providers ?? []),
    ...(responses?.flatMap(response => response.content.providers ?? []) ?? []),
    'RECENT_MESSAGES',
  ]),
];

// Model usage with OBJECT_LARGE
const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
  prompt: composePromptFromState({
    state,
    template: replyTemplate,
  }),
});

// Robust error handling
try {
  // Response processing
} catch (error) {
  console.error('Error in reply action handler:', error);
  // Fallback response generation
}
```

## ✅ Acceptance Criteria

- [ ] Documentation shows accurate REPLY action implementation
- [ ] All imports are included and correct
- [ ] Complex provider handling is explained
- [ ] Error handling patterns are documented
- [ ] Model type usage is accurate
- [ ] Response structure matches actual implementation
- [ ] Code includes proper TypeScript types

## 🔧 Implementation Steps

### 1. Update REPLY Action Example

Replace the oversimplified example with a more accurate representation:

```typescript
import { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback,
  ModelType,
  composePromptFromState,
  parseJSONObjectFromText
} from '@elizaos/core';

const replyAction: Action = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description: 'Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return true; // Always valid - this is the default action
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<unknown> => {
    try {
      // Collect providers from all sources
      const allProviders = [
        ...new Set([
          ...(message.content.providers ?? []),
          ...(responses?.flatMap(response => response.content.providers ?? []) ?? []),
          'RECENT_MESSAGES',
        ]),
      ];

      // Compose state with collected providers
      state = await runtime.composeState(message, allProviders);

      // Generate response using object-based model
      const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt: composePromptFromState({
          state,
          template: replyTemplate, // Import from template file
        }),
      });

      // Parse and validate response
      const responseContentObj = parseJSONObjectFromText(response);
      
      const responseContent = {
        thought: responseContentObj.thought,
        text: responseContentObj.message || '',
        actions: ['REPLY'],
      };

      // Send response via callback
      if (callback) {
        await callback(responseContent);
      }

      return true;
      
    } catch (error) {
      console.error('Error in reply action handler:', error);
      
      // Fallback response
      if (callback) {
        await callback({
          text: "I'm having trouble responding right now. Please try again.",
          actions: ['REPLY'],
        });
      }
      
      return false;
    }
  },

  examples: [
    // Include actual examples from the implementation
  ],
};

export default replyAction;
```

### 2. Add Implementation Notes

Add explanatory sections after the code:

```markdown
### Implementation Details

#### Provider Collection Strategy
The REPLY action collects providers from multiple sources:
- Message content providers
- Response providers from previous actions  
- Always includes `RECENT_MESSAGES` for context

This ensures the agent has comprehensive context for generating appropriate responses.

#### Model Selection
Uses `ModelType.OBJECT_LARGE` for structured JSON output rather than simple text generation, enabling:
- Structured thought/message separation
- Better parsing and validation
- More reliable response format

#### Error Handling
Includes comprehensive error handling with:
- Try-catch blocks around model invocation
- Fallback response generation
- Proper error logging
- Graceful degradation

#### Response Structure
Expects JSON response with:
```json
{
  "thought": "Internal reasoning process",
  "message": "User-facing response text"
}
```
```

### 3. Add Template Reference

```markdown
### Reply Template

The REPLY action uses a template that defines the expected response format:

> **Template Source**: [`packages/plugin-bootstrap/src/templates/reply.ts`](link-to-file)

The template guides the LLM to generate structured responses with separate thought and message components.
```

### 4. Cross-Reference Actual Implementation

Add clear reference to source:

```markdown
> **Complete Implementation**: See the full REPLY action implementation in [`packages/plugin-bootstrap/src/actions/reply.ts`](link-to-file) for all details including test cases and additional functionality.
```

## 📝 Files to Update

1. `/packages/docs/docs/core/actions.md` - Lines 171-216 (REPLY action section)
2. Add template documentation if not already present
3. Update any other references to simplified REPLY examples

## 🧪 Testing

- [ ] Verify documented code reflects actual implementation patterns
- [ ] Confirm all imports are available in @elizaos/core
- [ ] Test that model type and provider handling are accurate
- [ ] Validate error handling patterns match codebase standards
- [ ] Check that response structure matches actual usage

## 📚 Related Issues

- Issue #007: Action interface needs fixing (foundation for this work)
- Issue #009: Missing imports in all code examples
- Issue #015: Need file path references for all examples

## 💡 Additional Context

### Why Accurate Implementation Examples Matter

1. **Learning Resource**: Developers use these examples to understand patterns
2. **Best Practices**: Shows proper error handling, provider management, model usage
3. **Migration Guide**: Helps v1 users understand v2 patterns
4. **Debugging**: Accurate examples help troubleshoot implementation issues

### Implementation Complexity

The actual REPLY action is more sophisticated than documented because it:
- Handles multiple response scenarios
- Manages complex provider chains
- Uses structured model output
- Implements robust error recovery
- Supports advanced state management

### Documentation Philosophy

Rather than oversimplifying, documentation should show:
- Real-world complexity where it adds value
- Proper error handling patterns
- Modern TypeScript practices
- Integration with the broader system

## 📎 Source Code References

- Actual REPLY implementation: `/packages/plugin-bootstrap/src/actions/reply.ts`
- Reply template: `/packages/plugin-bootstrap/src/templates/reply.ts`
- Model types: `/packages/core/src/types/model.ts`
- Current documentation: `/packages/docs/docs/core/actions.md:171-216`