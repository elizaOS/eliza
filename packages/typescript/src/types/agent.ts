import type { DirectoryItem } from "./knowledge";
import type { Content, UUID } from "./primitives";
import type { State } from "./state";

/**
 * Example message for demonstration
 */
export interface MessageExample {
  /** Associated user */
  name: string;

  /** Message content */
  content: Content;
}

/**
 * Well-known character settings keys with their expected types.
 * These can be set in the character's `settings` field or in environment variables.
 */
export interface CharacterSettings {
  /**
   * Model type to use for shouldRespond evaluation.
   * - "small": Use TEXT_SMALL for fast, simple response decisions (default)
   * - "large": Use TEXT_LARGE for complex reasoning about whether to respond
   *
   * Use "large" when the agent needs to:
   * - Consider complex context for response decisions
   * - Do preliminary planning/reasoning about response strategy
   * - Handle nuanced social situations
   */
  SHOULD_RESPOND_MODEL?: "small" | "large";

  /**
   * Whether to use multi-step workflow for message handling.
   * When enabled, the agent will iterate through multiple steps
   * to complete complex tasks.
   */
  USE_MULTI_STEP?: boolean | string;

  /**
   * Maximum number of iterations for multi-step workflow.
   * @default 6
   */
  MAX_MULTISTEP_ITERATIONS?: number | string;

  /**
   * Whether LLM is off by default in rooms.
   * When true, agent won't respond unless explicitly followed.
   */
  BOOTSTRAP_DEFLLMOFF?: boolean | string;

  /**
   * Whether to keep responses even when superseded by newer messages.
   */
  BOOTSTRAP_KEEP_RESP?: boolean | string;

  /**
   * Timeout for provider execution in multi-step workflow (milliseconds).
   * @default 1000
   */
  PROVIDERS_TOTAL_TIMEOUT_MS?: number | string;

  /**
   * Maximum number of working memory entries to keep.
   * @default 50
   */
  MAX_WORKING_MEMORY_ENTRIES?: number | string;

  /**
   * Channel types that always trigger a response (comma-separated).
   * Adds to the default list: DM, VOICE_DM, SELF, API
   */
  ALWAYS_RESPOND_CHANNELS?: string;

  /**
   * Sources that always trigger a response (comma-separated).
   * Adds to the default list: client_chat
   */
  ALWAYS_RESPOND_SOURCES?: string;

  /** Model temperature (0.0 to 1.0) for all models */
  DEFAULT_TEMPERATURE?: number | string;

  /** Maximum tokens for text generation for all models */
  DEFAULT_MAX_TOKENS?: number | string;

  /** Frequency penalty for all models */
  DEFAULT_FREQUENCY_PENALTY?: number | string;

  /** Presence penalty for all models */
  DEFAULT_PRESENCE_PENALTY?: number | string;

  /**
   * Whether to disable basic capabilities (default: false).
   * Basic capabilities include core providers (character, actions, entities, etc.),
   * core actions (reply, ignore, none), and core services (task, embedding).
   * Set to true to disable all basic capabilities.
   */
  DISABLE_BASIC_CAPABILITIES?: boolean | string;

  /**
   * Whether to enable extended capabilities (default: false).
   * Extended capabilities include additional providers (facts, roles, settings, etc.),
   * additional actions (choice, sendMessage, updateSettings, etc.), and image generation.
   * Set to true to enable all extended capabilities.
   */
  ENABLE_EXTENDED_CAPABILITIES?: boolean | string;

  /** Allow additional settings */
  [key: string]:
    | string
    | boolean
    | number
    | Record<string, unknown>
    | undefined;
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

  /**
   * Optional configuration settings for the character.
   * See `CharacterSettings` for well-known settings and their descriptions.
   */
  settings?: CharacterSettings;

  /** Optional secrets (API keys, tokens, etc.) */
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
  ACTIVE = "active",
  INACTIVE = "inactive",
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
