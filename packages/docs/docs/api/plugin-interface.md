# Plugin Interface Reference

This document provides the complete Plugin interface definition and all related types as implemented in the ElizaOS codebase.

## Plugin Interface

The main `Plugin` interface defines the structure for extending agent functionality. All interfaces follow TypeScript best practices for clarity, type safety, and maintainability:

````typescript
/**
 * Plugin interface for extending agent functionality
 *
 * @example
 * ```typescript
 * const myPlugin: Plugin = {
 *   name: "example-plugin",
 *   description: "An example plugin for demonstration",
 *   actions: [myAction],
 *   providers: [myProvider],
 *   init: async (config, runtime) => {
 *     // Initialize plugin
 *   }
 * };
 * ```
 */
export interface Plugin {
  /** Unique identifier for the plugin */
  name: string;

  /** Human-readable description of plugin functionality */
  description: string;

  /**
   * Optional initialization function called when plugin is loaded
   * @param config - Configuration object from environment variables
   * @param runtime - Agent runtime instance for accessing services
   */
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;

  /** Plugin-specific configuration settings */
  config?: { [key: string]: any };

  /** Service classes that this plugin provides */
  services?: (typeof Service)[];

  /**
   * Entity component type definitions for structured data
   * Used for defining custom data schemas with optional validation
   */
  componentTypes?: {
    /** Component type name */
    name: string;
    /** JSON schema definition for the component */
    schema: Record<string, unknown>;
    /** Optional validation function for component data */
    validator?: (data: any) => boolean;
  }[];

  /** Actions that the agent can perform */
  actions?: Action[];

  /** Providers for supplying contextual information */
  providers?: Provider[];

  /** Evaluators for post-interaction processing */
  evaluators?: Evaluator[];

  /** Database adapter for custom storage implementations */
  adapter?: IDatabaseAdapter;

  /**
   * Model functions for AI/ML capabilities
   * Maps model names to their implementation functions
   */
  models?: {
    [key: string]: (...args: any[]) => Promise<any>;
  };

  /** Event handlers for plugin lifecycle events */
  events?: PluginEvents;

  /** HTTP routes exposed by the plugin */
  routes?: Route[];

  /** Test suites for plugin functionality */
  tests?: TestSuite[];

  /** Names of other plugins this plugin depends on */
  dependencies?: string[];

  /** Plugin dependencies only needed for testing */
  testDependencies?: string[];

  /** Loading priority (higher numbers load first) */
  priority?: number;

  /** JSON schema for plugin configuration validation */
  schema?: any;
}
````

## Route Type

Routes define HTTP endpoints exposed by plugins:

````typescript
/**
 * Defines an HTTP route exposed by a plugin
 *
 * @example
 * ```typescript
 * const apiRoute: Route = {
 *   type: 'GET',
 *   path: '/api/status',
 *   public: true,
 *   name: 'Status Check',
 *   handler: async (req, res, runtime) => {
 *     res.json({ status: 'running' });
 *   }
 * };
 * ```
 */
export type Route = {
  /** HTTP method for the route */
  type: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'STATIC';

  /** URL path for the route (e.g., '/api/data') */
  path: string;

  /** File path for STATIC routes to serve files */
  filePath?: string;

  /** Whether the route is publicly accessible without authentication */
  public?: boolean;

  /** Display name for public routes (shown in UI tabs) */
  name?: string extends { public: true } ? string : string | undefined;

  /**
   * Handler function for processing requests
   * @param req - HTTP request object
   * @param res - HTTP response object
   * @param runtime - Agent runtime instance
   */
  handler?: (req: any, res: any, runtime: IAgentRuntime) => Promise<void>;

  /** Whether the route expects multipart/form-data for file uploads */
  isMultipart?: boolean;
};
````

## PluginEvents Type

Defines event handlers for plugin lifecycle events:

````typescript
/**
 * Event handlers mapping for plugin lifecycle events
 *
 * @example
 * ```typescript
 * const pluginEvents: PluginEvents = {
 *   MESSAGE_RECEIVED: [handleMessage],
 *   WORLD_JOINED: [handleWorldJoin],
 *   customEvent: [handleCustom]
 * };
 * ```
 */
export type PluginEvents = {
  /** Standard event handlers mapped by event type */
  [K in keyof EventPayloadMap]?: EventHandler<K>[];
} & {
  /** Custom event handlers for plugin-specific events */
  [key: string]: ((params: any) => Promise<any>)[];
};
````

## Service Class

The abstract `Service` class provides the foundation for all plugin services:

````typescript
/**
 * Abstract base class for all ElizaOS services
 *
 * Services provide specialized functionality like transcription, video processing,
 * web browsing, and other capabilities that agents can utilize.
 *
 * @example
 * ```typescript
 * class TranscriptionService extends Service {
 *   static serviceType = 'transcription';
 *   capabilityDescription = 'Audio transcription service';
 *
 *   static async start(runtime: IAgentRuntime): Promise<Service> {
 *     return new TranscriptionService(runtime);
 *   }
 *
 *   async stop(): Promise<void> {
 *     // Cleanup logic
 *   }
 * }
 * ```
 */
export abstract class Service {
  /** Runtime instance for accessing agent capabilities */
  protected runtime!: IAgentRuntime;

  /**
   * @param runtime - Optional runtime instance, can be set later
   */
  constructor(runtime?: IAgentRuntime) {
    if (runtime) {
      this.runtime = runtime;
    }
  }

  /** Cleanup and stop the service */
  abstract stop(): Promise<void>;

  /** Unique identifier for this service type */
  static serviceType: string;

  /** Human-readable description of service capabilities */
  abstract capabilityDescription: string;

  /** Service-specific configuration metadata */
  config?: Metadata;

  /**
   * Start and initialize the service
   * @param _runtime - Agent runtime instance
   * @returns Promise resolving to the service instance
   */
  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error('Not implemented');
  }

  /**
   * Stop the service class-wide
   * @param _runtime - Agent runtime instance
   * @returns Promise for cleanup completion
   */
  static async stop(_runtime: IAgentRuntime): Promise<unknown> {
    throw new Error('Not implemented');
  }
}
````

## Service Type Registry

The service type registry defines all available service types:

```typescript
export interface ServiceTypeRegistry {
  TRANSCRIPTION: 'transcription';
  VIDEO: 'video';
  BROWSER: 'browser';
  PDF: 'pdf';
  REMOTE_FILES: 'aws_s3';
  WEB_SEARCH: 'web_search';
  EMAIL: 'email';
  TEE: 'tee';
  TASK: 'task';
  WALLET: 'wallet';
  LP_POOL: 'lp_pool';
  TOKEN_DATA: 'token_data';
  DATABASE_MIGRATION: 'database_migration';
  PLUGIN_MANAGER: 'PLUGIN_MANAGER';
  PLUGIN_CONFIGURATION: 'PLUGIN_CONFIGURATION';
  PLUGIN_USER_INTERACTION: 'PLUGIN_USER_INTERACTION';
}
```

## TypedService Interface

Generic service interface with better type checking:

```typescript
export interface TypedService<ConfigType extends Metadata = Metadata, ResultType = unknown>
  extends Service {
  /**
   * The configuration for this service instance
   */
  config?: ConfigType;

  /**
   * Process an input with this service
   * @param input The input to process
   * @returns A promise resolving to the result
   */
  process(input: unknown): Promise<ResultType>;
}
```

## Provider Interface

Providers supply external data and services to the agent:

````typescript
/**
 * Provider interface for supplying contextual information to agents
 *
 * Providers act as the agent's "senses", gathering dynamic information
 * from external sources to inform decision-making.
 *
 * @example
 * ```typescript
 * const weatherProvider: Provider = {
 *   name: 'weather',
 *   description: 'Current weather information',
 *   get: async (runtime, message, state) => {
 *     const weather = await fetchWeather(state.location);
 *     return {
 *       text: `Current weather: ${weather.description}, ${weather.temperature}°C`,
 *       data: weather
 *     };
 *   }
 * };
 * ```
 */
export interface Provider {
  /** Unique identifier for the provider */
  name: string;

  /** Human-readable description of what this provider supplies */
  description?: string;

  /**
   * Whether the provider generates dynamic content that changes over time
   * Dynamic providers are called more frequently
   */
  dynamic?: boolean;

  /**
   * Position in the provider execution order
   * Positive numbers = later in chain, negative = earlier
   */
  position?: number;

  /**
   * Whether the provider is private
   *
   * Private providers are not shown in provider lists and must be
   * explicitly called by name from actions or other providers
   */
  private?: boolean;

  /**
   * Data retrieval function called when agent needs this information
   * @param runtime - Agent runtime for accessing services and capabilities
   * @param message - Current message context triggering the provider
   * @param state - Current conversation state and context
   * @returns Promise resolving to provider data
   */
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}
````

## ProviderResult Type

Result structure returned by providers:

```typescript
export interface ProviderResult {
  values?: {
    [key: string]: any;
  };
  data?: {
    [key: string]: any;
  };
  text?: string;
}
```

## Action Interface

Actions define capabilities the agent can perform:

````typescript
/**
 * Interface for defining agent actions
 *
 * Actions represent specific capabilities or behaviors that an agent
 * can execute in response to messages or triggers.
 *
 * @example
 * ```typescript
 * const sendMessageAction: Action = {
 *   name: 'SEND_MESSAGE',
 *   description: 'Send a message to a specified recipient',
 *   similes: ['message', 'send', 'communicate'],
 *   examples: [[
 *     { name: 'User', content: { text: 'Send hello to John' } },
 *     { name: 'Assistant', content: { text: 'Message sent to John: Hello!' } }
 *   ]],
 *   validate: async (runtime, message) => {
 *     return message.content.text?.includes('send');
 *   },
 *   handler: async (runtime, message, state) => {
 *     // Implementation
 *   }
 * };
 * ```
 */
export interface Action {
  /** Alternative names or keywords that trigger this action */
  similes?: string[];

  /** Detailed description of what this action does */
  description: string;

  /**
   * Example conversation flows showing how to use this action
   * Each example is an array of message exchanges
   */
  examples?: ActionExample[][];

  /**
   * Handler function that executes the action
   * @param runtime - Agent runtime instance
   * @param message - Triggering message
   * @param state - Current conversation state
   * @param options - Additional options
   * @param callback - Callback for handling responses
   * @param responses - Previous responses in conversation
   */
  handler: Handler;

  /** Unique name identifying this action */
  name: string;

  /**
   * Validation function to determine if action should trigger
   * @param runtime - Agent runtime instance
   * @param message - Message to validate against
   * @param state - Current conversation state
   * @returns Promise resolving to boolean indicating if action applies
   */
  validate: Validator;
}
````

## Evaluator Interface

Evaluators assess agent responses and behavior:

````typescript
/**
 * Interface for defining agent evaluators
 *
 * Evaluators run after interactions to assess performance, learn from
 * conversations, and update agent knowledge or behavior patterns.
 *
 * @example
 * ```typescript
 * const sentimentEvaluator: Evaluator = {
 *   name: 'SENTIMENT_ANALYSIS',
 *   description: 'Analyzes conversation sentiment for learning',
 *   alwaysRun: true,
 *   examples: [{
 *     prompt: 'Analyze the emotional tone of this conversation',
 *     messages: [
 *       { name: 'User', content: { text: 'I\'m really frustrated with this' } },
 *       { name: 'Assistant', content: { text: 'I understand your frustration' } }
 *     ],
 *     outcome: 'Negative sentiment detected, empathetic response given'
 *   }],
 *   validate: async (runtime, message) => true,
 *   handler: async (runtime, message, state) => {
 *     // Sentiment analysis implementation
 *   }
 * };
 * ```
 */
export interface Evaluator {
  /**
   * Whether this evaluator should run after every interaction
   * If false, only runs when validate() returns true
   */
  alwaysRun?: boolean;

  /** Detailed description of what this evaluator analyzes */
  description: string;

  /** Alternative names or keywords for this evaluator */
  similes?: string[];

  /**
   * Example scenarios showing what this evaluator looks for
   * Each example includes context, sample messages, and expected outcome
   */
  examples: EvaluationExample[];

  /**
   * Handler function that performs the evaluation
   * @param runtime - Agent runtime instance
   * @param message - Message or interaction to evaluate
   * @param state - Current conversation state
   * @param options - Additional evaluation options
   * @param callback - Callback for handling evaluation results
   * @param responses - Previous responses for context
   */
  handler: Handler;

  /** Unique name identifying this evaluator */
  name: string;

  /**
   * Validation function to determine if evaluator should run
   * @param runtime - Agent runtime instance
   * @param message - Message to validate against
   * @param state - Current conversation state
   * @returns Promise resolving to boolean indicating if evaluator applies
   */
  validate: Validator;
}
````

## TestSuite Interface

Test suites organize related test cases:

````typescript
/**
 * Test suite for organizing related test cases
 *
 * Test suites group related tests together and are used by the ElizaOS
 * test runner to systematically validate plugin functionality.
 *
 * @example
 * ```typescript
 * const pluginTestSuite: TestSuite = {
 *   name: 'Message Processing Tests',
 *   tests: [
 *     {
 *       name: 'should process text messages',
 *       fn: async (runtime) => {
 *         const result = await runtime.processMessage(testMessage);
 *         assert(result.success);
 *       }
 *     },
 *     {
 *       name: 'should handle empty messages',
 *       fn: async (runtime) => {
 *         const result = await runtime.processMessage(emptyMessage);
 *         assert(!result.success);
 *       }
 *     }
 *   ]
 * };
 * ```
 */
export interface TestSuite {
  /** Descriptive name for the test suite (e.g., "Core Functionality Tests") */
  name: string;

  /** Array of test cases that belong to this suite */
  tests: TestCase[];
}
````

## TestCase Interface

Individual test cases for plugin functionality:

````typescript
/**
 * Individual test case for validating specific functionality
 *
 * Test cases contain the actual test logic and assertions. They receive
 * access to the agent runtime to test interactions and behaviors.
 *
 * @example
 * ```typescript
 * const greetingTest: TestCase = {
 *   name: 'should respond to greetings appropriately',
 *   fn: async (runtime) => {
 *     const message = createTestMessage('Hello!');
 *     const response = await runtime.processMessage(message);
 *
 *     assert(response, 'Should generate a response');
 *     assert(response.content.text.includes('hello'), 'Should acknowledge greeting');
 *   }
 * };
 * ```
 */
export interface TestCase {
  /** Descriptive name for the test case (e.g., "should respond to greetings") */
  name: string;

  /**
   * Test execution function containing the test logic and assertions
   *
   * @param runtime - Agent runtime instance providing access to all agent
   *                  capabilities, services, and test utilities
   * @returns Promise for async tests, or void for synchronous tests
   *
   * The function should use assertions to verify expected behavior and
   * throw errors when tests fail.
   */
  fn: (runtime: IAgentRuntime) => Promise<void> | void;
}
````

## ProjectAgent Interface

Defines agents within a project:

```typescript
export interface ProjectAgent {
  character: Character;
  init?: (runtime: IAgentRuntime) => Promise<void>;
  plugins?: Plugin[];
  tests?: TestSuite | TestSuite[];
}
```

## Project Interface

Top-level project structure:

```typescript
export interface Project {
  agents: ProjectAgent[];
}
```

## Event Types

Standard event types across all platforms:

```typescript
export enum EventType {
  // World events
  WORLD_JOINED = 'WORLD_JOINED',
  WORLD_CONNECTED = 'WORLD_CONNECTED',
  WORLD_LEFT = 'WORLD_LEFT',

  // Entity events
  ENTITY_JOINED = 'ENTITY_JOINED',
  ENTITY_LEFT = 'ENTITY_LEFT',
  ENTITY_UPDATED = 'ENTITY_UPDATED',

  // Room events
  ROOM_JOINED = 'ROOM_JOINED',
  ROOM_LEFT = 'ROOM_LEFT',

  // Message events
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',
  MESSAGE_DELETED = 'MESSAGE_DELETED',

  // Channel events
  CHANNEL_CLEARED = 'CHANNEL_CLEARED',

  // Voice events
  VOICE_MESSAGE_RECEIVED = 'VOICE_MESSAGE_RECEIVED',
  VOICE_MESSAGE_SENT = 'VOICE_MESSAGE_SENT',

  // Interaction events
  REACTION_RECEIVED = 'REACTION_RECEIVED',
  POST_GENERATED = 'POST_GENERATED',
  INTERACTION_RECEIVED = 'INTERACTION_RECEIVED',

  // Run events
  RUN_STARTED = 'RUN_STARTED',
  RUN_ENDED = 'RUN_ENDED',
  RUN_TIMEOUT = 'RUN_TIMEOUT',

  // Action events
  ACTION_STARTED = 'ACTION_STARTED',
  ACTION_COMPLETED = 'ACTION_COMPLETED',

  // Evaluator events
  EVALUATOR_STARTED = 'EVALUATOR_STARTED',
  EVALUATOR_COMPLETED = 'EVALUATOR_COMPLETED',

  // Model events
  MODEL_USED = 'MODEL_USED',
}
```

## Event Handler Type

Generic event handler function type:

```typescript
export type EventHandler<T extends keyof EventPayloadMap> = (
  payload: EventPayloadMap[T]
) => Promise<void>;
```

## Usage Notes

1. **Plugin Registration**: Plugins are registered with the runtime through the `plugins` array in `ProjectAgent` or directly via the runtime's plugin management system.

2. **Service Integration**: Services are registered using the `ServiceType` constants and can be accessed via `runtime.getService()`.

3. **Event Handling**: Plugin events are automatically registered when the plugin is loaded and are triggered based on the event type.

4. **Route Exposure**: HTTP routes with `public: true` are exposed as HTML tabs in the agent interface.

5. **Testing**: Use the `TestSuite` structure to organize plugin tests, which can be run via the ElizaOS test runner.

This interface provides a comprehensive foundation for creating modular, extensible plugins that integrate seamlessly with the ElizaOS agent runtime.
