import type { DirectoryItem } from './knowledge';
import type { Content, UUID } from './primitives';
import type { State } from './state';

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
    [key: string]: string | boolean | number | Record<string, any>;
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
