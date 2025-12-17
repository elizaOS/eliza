import type { DirectoryItem } from './knowledge';
import type { Content, UUID } from './primitives';
import type { State } from './state';

/**
 * Lore entry for character-specific knowledge that can be retrieved via RAG
 */
export interface LoreEntry {
  /** Unique key identifier for the lore entry (e.g., "axiom_love_vs_relationship") */
  loreKey: string;

  /** Text used for vector embedding and semantic search */
  vectorText: string;

  /** The actual lore content/knowledge */
  content: string;

  /** Optional metadata for additional context */
  metadata?: Record<string, unknown>;
}

/**
 * Example message for demonstration
 */
export interface MessageExample {
  /** Associated user */
  name: string;

  /** Message content */
  content: Content;
}

export type TemplateType =
  | string
  | ((options: { state: State | { [key: string]: string } }) => string);

/**
 * Configuration for an agent's character, defining its personality, knowledge, and capabilities.
 * This is a central piece of an agent's definition, used by the `AgentRuntime` to initialize and operate the agent.
 * It includes:
 * - `id`: Optional unique identifier for the character.
 * - `name`, `username`: Identifying names for the character.
 * - `system`: A system prompt that guides the agent's overall behavior.
 * - `templates`: A map of prompt templates for various situations (e.g., message generation, summarization).
 * - `bio`: A textual biography or description of the character.
 * - `messageExamples`, `postExamples`: Examples of how the character communicates.
 * - `topics`, `adjectives`: Keywords describing the character's knowledge areas and traits.
 * - `knowledge`: Paths to knowledge files or directories to be loaded into the agent's memory.
 * - `plugins`: A list of plugin names to be loaded for this character.
 * - `settings`, `secrets`: Configuration key-value pairs, with secrets being handled more securely.
 * - `style`: Guidelines for the character's writing style in different contexts (chat, post).
 */
export interface Character {
  /** Optional unique identifier */
  id?: UUID;

  /** Character name */
  name: string;

  /** Optional username */
  username?: string;

  /** Optional system prompt */
  system?: string;

  /** Optional prompt templates */
  templates?: {
    [key: string]: TemplateType;
  };

  /** Character biography */
  bio: string | string[];

  /**
   * RAG-based lore entries for contextual knowledge retrieval.
   *
   * **Purpose**: Dynamic context injection based on keywords or semantic search.
   *
   * **Use Cases**:
   * 1. **Active Steering**: Inject behavioral mode switches
   *    Example: keyword "combat" → "Use terse military language"
   * 2. **World Info**: Characters, locations, events in universe
   * 3. **Specialized Knowledge**: Domain-specific responses
   *
   * **Structure**: See LoreEntry interface
   * - `loreKey`: Unique identifier
   * - `vectorText`: Keywords for semantic search
   * - `content`: Text to inject (can be instructions or info)
   *
   * **Injected**: System prompt, when keyword/semantic match found
   *
   * Requires: plugin-lorebook + embedding model
   */
  lore?: LoreEntry[];

  /** Example messages */
  messageExamples?: MessageExample[][];

  /** Example posts */
  postExamples?: string[];

  /** Known topics */
  topics?: string[];

  /** Character traits */
  adjectives?: string[];

  /** Optional knowledge base */
  knowledge?: (string | { path: string; shared?: boolean } | DirectoryItem)[];

  /** Available plugins */
  plugins?: string[];

  /** Optional configuration */
  settings?: {
    [key: string]: string | boolean | number | Record<string, unknown>;
  };

  /** Optional secrets */
  secrets?: {
    [key: string]: string | boolean | number;
  };

  /** Writing style guides */
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
}

export enum AgentStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Represents an operational agent, extending the `Character` definition with runtime status and timestamps.
 * While `Character` defines the blueprint, `Agent` represents an instantiated and potentially running version.
 * It includes:
 * - `enabled`: A boolean indicating if the agent is currently active or disabled.
 * - `status`: The current operational status, typically `AgentStatus.ACTIVE` or `AgentStatus.INACTIVE`.
 * - `createdAt`, `updatedAt`: Timestamps for when the agent record was created and last updated in the database.
 * This interface is primarily used by the `IDatabaseAdapter` for agent management.
 */
export interface Agent extends Character {
  enabled?: boolean;
  status?: AgentStatus;
  createdAt: number;
  updatedAt: number;
}
