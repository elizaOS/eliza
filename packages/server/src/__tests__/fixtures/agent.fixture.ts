/**
 * AgentFixture - Manages agent lifecycle for testing
 *
 * Creates and manages agent instances with proper initialization and cleanup.
 * Handles character configuration, plugin registration, and runtime management.
 * Implements Symbol.asyncDispose for automatic cleanup.
 *
 * @example
 * ```typescript
 * describe('My Test Suite', () => {
 *   it('should work with test agent', async () => {
 *     await using agentFixture = new AgentFixture(agentServer);
 *     const { runtime, agentId } = await agentFixture.setup();
 *
 *     // Test code here - cleanup is automatic!
 *   });
 * });
 * ```
 */

import type { Character, Plugin, IAgentRuntime, UUID } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { AgentServer } from '../../index';
import { CharacterBuilder } from '../builders/character.builder';

/**
 * Mock model provider plugin to prevent TEXT_SMALL handler errors
 */
const mockModelProviderPlugin: Plugin = {
  name: 'mockModelProvider',
  description: 'Mock model provider for testing',
  actions: [],
  evaluators: [],
  providers: [],
  services: [],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Register a mock model handler for all model types
    const mockHandler = async () => 'mock response';
    runtime.registerModel(ModelType.TEXT_SMALL, mockHandler, 'mock');
    runtime.registerModel(ModelType.TEXT_LARGE, mockHandler, 'mock');
    runtime.registerModel(ModelType.TEXT_EMBEDDING, mockHandler, 'mock');
  },
};

/**
 * Options for agent fixture setup
 */
export interface AgentFixtureOptions {
  /**
   * Character configuration for the agent
   * If not provided, a default test character will be created
   */
  character?: Character;

  /**
   * Additional plugins to register with the agent
   * Mock model provider is always included
   */
  plugins?: Plugin[];

  /**
   * Whether to wait after agent initialization
   * @default 500ms
   */
  initWaitMs?: number;

  /**
   * Custom character builder preset to use
   * @example 'asTestAgent', 'asDatabaseTestAgent', 'asOpenAIAgent'
   */
  characterPreset?: 'asTestAgent' | 'asDatabaseTestAgent' | 'asSocketIOTestAgent' | 'asOpenAIAgent';

  /**
   * Custom name for the agent (overrides preset name)
   */
  name?: string;
}

/**
 * Result returned from agent fixture setup
 */
export interface AgentFixtureResult {
  /**
   * The agent runtime instance
   */
  runtime: IAgentRuntime;

  /**
   * The agent's unique identifier
   */
  agentId: UUID;

  /**
   * The character used by the agent
   */
  character: Character;
}

/**
 * Agent fixture for managing test agents
 */
export class AgentFixture {
  private agentServer: AgentServer;
  private runtime: IAgentRuntime | null = null;
  private agentId: UUID | null = null;
  private character: Character | null = null;
  private cleanupPerformed = false;

  constructor(agentServer: AgentServer) {
    this.agentServer = agentServer;
  }

  /**
   * Set up a test agent
   */
  async setup(options: AgentFixtureOptions = {}): Promise<AgentFixtureResult> {
    // Create character if not provided
    if (!this.character) {
      if (options.character) {
        this.character = options.character;
      } else {
        // Use preset or default to asTestAgent
        const builder = new CharacterBuilder();
        const preset = options.characterPreset || 'asTestAgent';
        builder[preset]();

        // Override name if provided
        if (options.name) {
          builder.withName(options.name);
        }

        this.character = builder.build();
      }
    }

    // Combine mock model provider with any additional plugins
    const plugins = [mockModelProviderPlugin, ...(options.plugins || [])];

    // Start agent in test mode (skips env merge to avoid database bloat)
    const [runtime] = await this.agentServer.startAgents(
      [
        {
          character: this.character,
          plugins,
        },
      ],
      { isTestMode: true }
    );

    this.runtime = runtime;
    this.agentId = runtime.agentId;

    // Wait for agent to fully initialize
    const waitMs = options.initWaitMs ?? 500;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return {
      runtime: this.runtime,
      agentId: this.agentId,
      character: this.character,
    };
  }

  /**
   * Get the agent runtime (must call setup() first)
   */
  getRuntime(): IAgentRuntime {
    if (!this.runtime) {
      throw new Error('AgentFixture not initialized. Call setup() first.');
    }
    return this.runtime;
  }

  /**
   * Get the agent ID (must call setup() first)
   */
  getAgentId(): UUID {
    if (!this.agentId) {
      throw new Error('AgentFixture not initialized. Call setup() first.');
    }
    return this.agentId;
  }

  /**
   * Get the character (must call setup() first)
   */
  getCharacter(): Character {
    if (!this.character) {
      throw new Error('AgentFixture not initialized. Call setup() first.');
    }
    return this.character;
  }

  /**
   * Clean up agent resources
   */
  async cleanup(): Promise<void> {
    if (this.cleanupPerformed) {
      return;
    }

    try {
      if (this.agentId) {
        try {
          await this.agentServer.stopAgents([this.agentId]);
          // Give agent time to clean up connections
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          console.warn(`Failed to stop agent ${this.agentId}:`, error);
        }
      }
    } finally {
      this.cleanupPerformed = true;
      this.runtime = null;
      this.agentId = null;
      this.character = null;
    }
  }

  /**
   * Symbol.asyncDispose implementation for automatic cleanup
   * Enables `await using` syntax
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }

  /**
   * Helper to create multiple test agents
   */
  static async createMany(
    agentServer: AgentServer,
    count: number,
    options: AgentFixtureOptions = {}
  ): Promise<AgentFixtureResult[]> {
    const fixtures: AgentFixture[] = [];
    const results: AgentFixtureResult[] = [];

    try {
      for (let i = 1; i <= count; i++) {
        const fixture = new AgentFixture(agentServer);
        fixtures.push(fixture);

        const agentOptions = {
          ...options,
          name: options.name ? `${options.name} ${i}` : `Test Agent ${i}`,
        };

        const result = await fixture.setup(agentOptions);
        results.push(result);
      }

      return results;
    } catch (error) {
      // Cleanup on error
      for (const fixture of fixtures) {
        await fixture.cleanup().catch(console.warn);
      }
      throw error;
    }
  }

  /**
   * Helper to create a quick test agent
   * @returns Agent fixture result with cleanup function
   */
  static async createQuick(
    agentServer: AgentServer,
    options: AgentFixtureOptions = {}
  ): Promise<AgentFixtureResult & { cleanup: () => Promise<void> }> {
    const fixture = new AgentFixture(agentServer);
    const result = await fixture.setup(options);

    return {
      ...result,
      cleanup: () => fixture.cleanup(),
    };
  }
}
