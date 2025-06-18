# Code Examples Are Not Self-Contained

## 📝 Priority: Medium

## 📋 Issue Summary

Code examples throughout the documentation lack imports, file references, and complete context, making them difficult to use in isolation. Developers cannot copy-paste examples and expect them to work without significant additional research.

## 🐛 Problem Description

### Current Example State

Most code examples show only the core implementation without:
- Required import statements
- File path context
- Complete working setup
- Export statements
- Usage examples

### Example: Action Implementation

**Current documentation:**
```typescript
const customAction: Action = {
  name: 'CUSTOM_ACTION',
  // ... implementation
};
```

**What developers need:**
```typescript
// File: src/actions/customAction.ts
import { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback,
  Content 
} from '@elizaos/core';

const customAction: Action = {
  name: 'CUSTOM_ACTION',
  description: 'Detailed description of when and how to use this action',
  
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Validation logic
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<unknown> => {
    // Implementation logic
    const responseContent: Content = {
      text: 'Response text',
      actions: ['CUSTOM_ACTION'],
    };

    if (callback) {
      await callback(responseContent);
    }

    return true;
  },
};

export default customAction;

// Usage in plugin:
// import customAction from './actions/customAction';
// 
// export const myPlugin: Plugin = {
//   name: 'my-plugin',
//   actions: [customAction],
// };
```

### Missing Context Categories

#### **1. File Structure Context**
- Where files should be placed
- How files relate to project structure
- Import/export patterns

#### **2. Complete Implementation**
- Full working examples with all dependencies
- Error handling patterns
- TypeScript type annotations

#### **3. Integration Examples**
- How components work together
- Plugin integration patterns
- Agent configuration usage

#### **4. Testing Context**
- How to test the examples
- Validation patterns
- Common debugging approaches

## ✅ Acceptance Criteria

- [ ] All code examples are self-contained and runnable
- [ ] Complete import statements included
- [ ] File path context provided
- [ ] Export statements shown where relevant
- [ ] Usage examples demonstrate integration
- [ ] Testing guidance included
- [ ] Error handling patterns shown

## 🔧 Implementation Steps

### 1. Create Self-Contained Action Example

```typescript
// File: src/actions/greetingAction.ts
// Purpose: Demonstrates a complete action implementation with all required imports

import { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback,
  Content,
  ModelType,
  composePromptFromState
} from '@elizaos/core';

/**
 * Greeting Action - Responds to greeting messages with personalized responses
 * 
 * Triggers: "hello", "hi", "hey", "greetings"
 * Context: Uses TIME provider for time-aware responses
 * Response: Generates personalized greeting based on user and time
 */
const greetingAction: Action = {
  name: 'GREETING',
  description: 'Responds to user greetings with personalized, time-aware messages',
  
  similes: ['HELLO', 'HI', 'HEY', 'GREET'],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text.toLowerCase();
    const greetingWords = ['hello', 'hi', 'hey', 'greetings', 'good morning', 'good evening'];
    
    return greetingWords.some(word => text.includes(word));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<unknown> => {
    try {
      // Compose state with time context for time-aware greetings
      state = await runtime.composeState(message, ['TIME', 'RECENT_MESSAGES']);

      // Generate personalized response
      const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt: composePromptFromState({
          state,
          template: `Generate a friendly greeting response. Consider the time of day and any previous conversation context.`
        }),
      });

      const responseContent: Content = {
        text: response.message || 'Hello! Nice to meet you!',
        actions: ['GREETING'],
      };

      if (callback) {
        await callback(responseContent);
      }

      return true;

    } catch (error) {
      console.error('Greeting action failed:', error);
      
      // Fallback response
      if (callback) {
        await callback({
          text: 'Hello there! How can I help you today?',
          actions: ['GREETING'],
        });
      }
      
      return false;
    }
  },

  examples: [
    [
      {
        name: 'User',
        content: { text: 'Hello there!' }
      },
      {
        name: 'Agent',
        content: { 
          text: 'Hello! Great to see you today. How can I assist you?',
          actions: ['GREETING']
        }
      }
    ]
  ],
};

export default greetingAction;

// Usage Example:
// 
// 1. In a plugin file (src/plugin.ts):
// import greetingAction from './actions/greetingAction';
// 
// export const myPlugin: Plugin = {
//   name: 'greeting-plugin',
//   actions: [greetingAction],
// };
//
// 2. In agent configuration:
// {
//   "name": "MyAgent",
//   "plugins": ["./src/plugin.ts"]
// }
//
// 3. Testing:
// npm test -- --testNamePattern="greeting"
```

### 2. Create Complete Service Example

```typescript
// File: src/services/weatherService.ts
// Purpose: Complete service implementation with external API integration

import { 
  Service,
  IAgentRuntime,
  ServiceDefinition,
  ServiceType
} from '@elizaos/core';

// Define service interface
interface WeatherData {
  temperature: number;
  condition: string;
  location: string;
  timestamp: Date;
}

/**
 * Weather Service - Provides current weather information
 * 
 * Features:
 * - Fetches real-time weather data
 * - Caches results to avoid API rate limits
 * - Handles errors gracefully
 * - Integrates with multiple weather APIs
 */
export class WeatherService extends Service {
  private cache: Map<string, { data: WeatherData; expires: Date }> = new Map();
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async initialize(): Promise<void> {
    console.log('Weather service initialized');
  }

  async start(): Promise<void> {
    console.log('Weather service started');
  }

  async stop(): Promise<void> {
    this.cache.clear();
    console.log('Weather service stopped');
  }

  /**
   * Get current weather for a location
   * @param location - City name or coordinates
   * @returns Weather data or null if unavailable
   */
  async getCurrentWeather(location: string): Promise<WeatherData | null> {
    try {
      // Check cache first
      const cached = this.cache.get(location);
      if (cached && cached.expires > new Date()) {
        return cached.data;
      }

      // Fetch from API (example implementation)
      const response = await fetch(`https://api.weather.com/v1/current?key=${this.apiKey}&q=${location}`);
      
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }

      const apiData = await response.json();
      
      const weatherData: WeatherData = {
        temperature: apiData.temp_c,
        condition: apiData.condition.text,
        location: apiData.location.name,
        timestamp: new Date(),
      };

      // Cache result for 10 minutes
      this.cache.set(location, {
        data: weatherData,
        expires: new Date(Date.now() + 10 * 60 * 1000),
      });

      return weatherData;

    } catch (error) {
      console.error('Failed to fetch weather:', error);
      return null;
    }
  }
}

// Service registration
export const weatherServiceDefinition: ServiceDefinition = {
  name: 'weather',
  serviceType: ServiceType.EXTERNAL_API,
  implementation: WeatherService,
};

// Usage Example:
//
// 1. In plugin configuration (src/plugin.ts):
// import { weatherServiceDefinition } from './services/weatherService';
// 
// export const weatherPlugin: Plugin = {
//   name: 'weather-plugin',
//   services: [weatherServiceDefinition],
// };
//
// 2. In action handler:
// const weatherService = runtime.getService('weather') as WeatherService;
// const weather = await weatherService.getCurrentWeather('New York');
//
// 3. Environment setup (.env):
// WEATHER_API_KEY=your_api_key_here
//
// 4. Testing (src/services/__tests__/weatherService.test.ts):
// import { WeatherService } from '../weatherService';
// 
// describe('WeatherService', () => {
//   test('fetches weather data', async () => {
//     const service = new WeatherService('test-key');
//     await service.initialize();
//     // ... test implementation
//   });
// });
```

### 3. Create Complete Plugin Example

```typescript
// File: src/index.ts
// Purpose: Complete plugin with all components integrated

import { Plugin } from '@elizaos/core';

// Import all components
import greetingAction from './actions/greetingAction';
import timeProvider from './providers/timeProvider';
import conversationEvaluator from './evaluators/conversationEvaluator';
import { weatherServiceDefinition } from './services/weatherService';

/**
 * Example Plugin - Demonstrates complete plugin structure
 * 
 * Components:
 * - Action: Greeting responses
 * - Provider: Time-based context
 * - Evaluator: Conversation quality analysis
 * - Service: Weather information
 */
export const examplePlugin: Plugin = {
  name: 'example-plugin',
  version: '1.0.0',
  description: 'Complete example plugin demonstrating all ElizaOS features',
  
  actions: [greetingAction],
  providers: [timeProvider],
  evaluators: [conversationEvaluator],
  services: [weatherServiceDefinition],
};

export default examplePlugin;

// Project Structure:
// src/
// ├── index.ts                 (this file)
// ├── actions/
// │   └── greetingAction.ts
// ├── providers/
// │   └── timeProvider.ts
// ├── evaluators/
// │   └── conversationEvaluator.ts
// ├── services/
// │   └── weatherService.ts
// └── __tests__/
//     ├── actions/
//     ├── providers/
//     ├── evaluators/
//     └── services/
//
// Installation:
// 1. npm install @elizaos/core
// 2. Add to agent configuration:
//    "plugins": ["./path/to/this/plugin"]
// 3. Configure environment variables if needed
// 4. Test: npm test
```

### 4. Add Integration Examples

Create sections showing how examples work together:

```markdown
## Complete Integration Example

This example shows how to create a complete plugin with all components working together:

### 1. Project Setup
```bash
# Create new plugin project
elizaos create my-weather-plugin --type plugin

# Install dependencies
cd my-weather-plugin
npm install

# Set up environment
cp .env.example .env
# Add your API keys to .env
```

### 2. File Structure
```
my-weather-plugin/
├── src/
│   ├── index.ts           # Main plugin file
│   ├── actions/
│   │   └── weatherAction.ts
│   ├── services/
│   │   └── weatherService.ts
│   └── __tests__/
│       └── integration.test.ts
├── package.json
└── .env
```

### 3. Testing Your Plugin
```bash
# Run unit tests
npm test

# Test in development
elizaos dev --plugin ./src/index.ts

# Integration test
elizaos test --name "weather"
```
```

## 📝 Files to Update

### Major Documentation Updates
1. `/packages/docs/docs/core/actions.md` - Replace all examples with self-contained versions
2. `/packages/docs/docs/core/services.md` - Add complete service examples
3. `/packages/docs/docs/core/plugins.md` - Show complete plugin structure
4. `/packages/docs/docs/core/providers.md` - Self-contained provider examples
5. `/packages/docs/docs/core/evaluators.md` - Complete evaluator implementations

### New Example Files
1. `/packages/docs/docs/examples/complete-action.md` - Full action implementation
2. `/packages/docs/docs/examples/complete-service.md` - Full service implementation
3. `/packages/docs/docs/examples/complete-plugin.md` - Full plugin with all components

## 🧪 Testing

- [ ] Copy each example into a new project and verify it compiles
- [ ] Test that all imports resolve correctly
- [ ] Verify examples work in actual ElizaOS environment
- [ ] Confirm file paths match recommended project structure
- [ ] Test integration examples end-to-end

## 📚 Related Issues

- Issue #009: Missing imports (foundation for this work)
- Issue #014: File path references (complements self-contained examples)
- Issue #015: Working example sections (extends this concept)

## 💡 Additional Context

### Why Self-Contained Examples Matter

1. **Developer Experience**: Copy-paste functionality reduces friction
2. **Learning**: Complete examples show proper patterns and structure
3. **Debugging**: Full context helps identify issues faster
4. **Standards**: Establishes consistent code organization patterns

### Example Completeness Levels

1. **Basic**: Core implementation only
2. **Complete**: Includes imports, exports, types
3. **Self-Contained**: Runnable with minimal setup
4. **Production-Ready**: Includes error handling, tests, documentation

The documentation should aim for "Self-Contained" as the standard, with "Production-Ready" examples for complex features.

## 📎 Source Code References

- Example patterns: `/packages/plugin-bootstrap/src/`
- Project templates: `/packages/project-starter/src/`
- Real implementations: Various plugin packages
- TypeScript configs: `/packages/*/tsconfig.json`