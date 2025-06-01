# Eliza Specification System

The Eliza specification system provides versioned APIs that ensure plugin compatibility across core system updates.

## Overview

When building plugins for Eliza, you can choose to target a specific API version (v1, v2, etc.) to ensure your plugin continues to work even as the core system evolves. Each version provides a stable interface that won't change, with automatic compatibility wrappers handling any differences with the current core implementation.

## Using Versioned APIs

### Import from a Specific Version

```typescript
// Import v2 types and utilities
import { Action, IAgentRuntime, Memory } from '@elizaos/core/v2';

// Import v1 types (if you need backwards compatibility)
import { Action as ActionV1 } from '@elizaos/core/v1';
```

### Import Latest Version (Default)

```typescript
// Import latest version (currently v2)
import { Action, IAgentRuntime } from '@elizaos/core';
```

## Example: Creating a v2-Compatible Plugin

```typescript
import { Plugin, Action, IAgentRuntime, Memory, State } from '@elizaos/core/v2';

const greetAction: Action = {
  name: 'greet',
  description: 'Greet a user',
  similes: ['hello', 'hi', 'hey'],

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text?.toLowerCase().includes('hello') ?? false;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const userName = state?.userName || 'friend';

    const response = await runtime.useModel('TEXT_SMALL', {
      prompt: `Generate a friendly greeting for ${userName}`,
      temperature: 0.8,
    });

    return {
      text: response,
      action: 'GREET_COMPLETED',
    };
  },

  examples: [
    [
      { name: 'user', content: { text: 'Hello!' } },
      { name: 'assistant', content: { text: 'Hello there! How can I help you today?' } },
    ],
  ],
};

export const greetPlugin: Plugin = {
  name: 'greet-plugin',
  description: 'A simple greeting plugin',
  actions: [greetAction],
};
```

## Version Compatibility

### What the Specification System Handles

1. **Type Conversions**: Automatically converts between versioned types and current core types
2. **Method Signatures**: Adapts method calls to match the expected signatures
3. **New Features**: Provides sensible defaults for features that didn't exist in older versions
4. **Removed Features**: Provides compatibility shims for features removed in newer versions
5. **Runtime Wrapping**: Wraps the runtime instance to ensure all methods work as expected

### Version History

- **v1**: Initial stable API (basic types and runtime methods)
- **v2**: Current stable API (full feature set with all core functionality)

## Best Practices

1. **Choose a Version**: Pick the API version that has the features you need
2. **Stick to the API**: Only use types and methods exported by your chosen version
3. **Test Compatibility**: Test your plugin with different core versions to ensure compatibility
4. **Document Requirements**: Clearly document which API version your plugin targets

## Migration Guide

### Migrating from Core Imports to Versioned Imports

```typescript
// Before (direct core import)
import { Action, IAgentRuntime } from '@elizaos/core';

// After (versioned import)
import { Action, IAgentRuntime } from '@elizaos/core/v2';
```

### Handling Version Differences

If you need to support multiple versions:

```typescript
import * as v1 from '@elizaos/core/v1';
import * as v2 from '@elizaos/core/v2';

// Use type guards or version detection to handle differences
function createAction(version: 'v1' | 'v2'): v1.Action | v2.Action {
  if (version === 'v1') {
    // Return v1-compatible action
  } else {
    // Return v2-compatible action
  }
}
```

## Future Compatibility

The specification system is designed to grow with Eliza:

- New versions (v3, v4, etc.) will be added as the core system evolves
- Existing versions will continue to work through compatibility wrappers
- Plugins can upgrade to newer versions at their own pace
- Breaking changes in core won't break plugins using versioned APIs

## Contributing

When adding new features to core:

1. Add them to the latest version spec
2. Ensure compatibility wrappers handle the differences
3. Document any migration requirements
4. Add tests for version compatibility

## Support

For questions about the specification system:

- Check the version-specific documentation in each spec folder
- Review the example implementations
- Ask in the Eliza community channels
