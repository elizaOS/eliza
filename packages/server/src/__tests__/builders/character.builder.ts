/**
 * CharacterBuilder - Type-safe test data builder for Character objects
 *
 * Provides a fluent API for creating valid Character instances in tests.
 * Uses the Builder pattern to ensure type safety and provide sensible defaults.
 *
 * @example
 * ```typescript
 * const character = new CharacterBuilder()
 *   .withName('Test Agent')
 *   .withBio(['A test agent'])
 *   .build();
 * ```
 */

import type { Character } from '@elizaos/core';

/**
 * Builder class for creating Character test data
 */
export class CharacterBuilder {
  private character: Partial<Character> = {
    topics: [],
    plugins: [],
    settings: {
      secrets: {},
    },
  };

  /**
   * Set the character name
   */
  withName(name: string): this {
    this.character.name = name;
    return this;
  }

  /**
   * Set the character bio
   */
  withBio(bio: string[]): this {
    this.character.bio = bio;
    return this;
  }

  /**
   * Set the character topics
   */
  withTopics(topics: string[]): this {
    this.character.topics = topics;
    return this;
  }

  /**
   * Set the character plugins
   */
  withPlugins(plugins: string[]): this {
    this.character.plugins = plugins;
    return this;
  }

  /**
   * Set character settings
   */
  withSettings(settings: Partial<Character['settings']>): this {
    if (!settings) {
      return this;
    }

    this.character.settings = {
      ...this.character.settings,
      ...Object.fromEntries(Object.entries(settings).filter(([_, v]) => v !== undefined)),
    } as Character['settings'];
    return this;
  }

  /**
   * Add a secret to character settings
   */
  withSecret(key: string, value: string): this {
    if (!this.character.settings) {
      this.character.settings = { secrets: {} };
    }
    if (!this.character.settings.secrets) {
      this.character.settings.secrets = {};
    }
    this.character.settings.secrets[key] = value;
    return this;
  }

  /**
   * Create a minimal test agent with sensible defaults
   */
  asTestAgent(): this {
    return this.withName('Test Agent').withBio(['A test agent for automated testing']);
  }

  /**
   * Create a minimal database test agent
   */
  asDatabaseTestAgent(): this {
    return this.withName('Database Test Agent').withBio(['Agent for database testing']);
  }

  /**
   * Create an agent suitable for Socket.IO tests
   */
  asSocketIOTestAgent(): this {
    return this.withName('SocketIO Test Agent').withBio(['Agent for Socket.IO testing']);
  }

  /**
   * Create an agent with OpenAI-like configuration
   */
  asOpenAIAgent(): this {
    return this.withName('OpenAI Test Agent')
      .withBio(['Agent configured for OpenAI'])
      .withSettings({
        model: 'gpt-4',
      })
      .withSecret('OPENAI_API_KEY', 'test-key');
  }

  /**
   * Build the final Character object
   *
   * @throws Error if required fields are missing
   */
  build(): Character {
    if (!this.character.name) {
      throw new Error(
        'Character must have a name. Use .withName() or a preset like .asTestAgent()'
      );
    }

    if (!this.character.bio || this.character.bio.length === 0) {
      throw new Error('Character must have a bio. Use .withBio() or a preset like .asTestAgent()');
    }

    return this.character as Character;
  }

  /**
   * Build multiple characters with incremental names
   *
   * @param count - Number of characters to create
   * @param prefix - Prefix for character names
   * @returns Array of Character objects
   *
   * @example
   * ```typescript
   * const agents = new CharacterBuilder()
   *   .asTestAgent()
   *   .buildMany(3, 'Agent');
   * // Creates: "Agent 1", "Agent 2", "Agent 3"
   * ```
   */
  buildMany(count: number, prefix = 'Agent'): Character[] {
    const characters: Character[] = [];

    for (let i = 1; i <= count; i++) {
      const builder = new CharacterBuilder();
      // Copy current state
      builder.character = { ...this.character };

      // Set incremental name
      builder.withName(`${prefix} ${i}`);

      characters.push(builder.build());
    }

    return characters;
  }
}
