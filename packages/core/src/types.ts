/**
 * Type definition for a Universally Unique Identifier (UUID) using a specific format.
 * @typedef {`${string}-${string}-${string}-${string}-${string}`} UUID
 */
/**
 * Defines a custom type UUID representing a universally unique identifier
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Helper function to safely cast a string to strongly typed UUID
 * @param id The string UUID to validate and cast
 * @returns The same UUID with branded type information
 */
export function asUUID(id: string): UUID {
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid UUID format: ${id}`);
  }
  return id as UUID;
}

/**
 * Represents the content of a memory, message, or other information
 */
export interface Content {
  /** The agent's internal thought process */
  thought?: string;

  /** The main text content visible to users */
  text?: string;

  /** Optional actions to be performed */
  actions?: string[];

  /** Optional providers to use for context generation */
  providers?: string[];

  /** Optional source/origin of the content */
  source?: string;

  /** URL of the original message/post (e.g. tweet URL, Discord message link) */
  url?: string;

  /** UUID of parent message if this is a reply/thread */
  inReplyTo?: UUID;

  /** Array of media attachments */
  attachments?: Media[];

  /**
   * Additional dynamic properties
   * Use specific properties above instead of this when possible
   */
  [key: string]: unknown;
}

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample {
  /** User associated with the example */
  name: string;

  /** Content of the example */
  content: Content;
}

export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType] | string;

/**
 * Model size/type classification
 */
export const ModelType = {
  SMALL: 'TEXT_SMALL', // kept for backwards compatibility
  MEDIUM: 'TEXT_LARGE', // kept for backwards compatibility
  LARGE: 'TEXT_LARGE', // kept for backwards compatibility
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
  TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  TEXT_TOKENIZER_ENCODE: 'TEXT_TOKENIZER_ENCODE',
  TEXT_TOKENIZER_DECODE: 'TEXT_TOKENIZER_DECODE',
  TEXT_REASONING_SMALL: 'REASONING_SMALL',
  TEXT_REASONING_LARGE: 'REASONING_LARGE',
  TEXT_COMPLETION: 'TEXT_COMPLETION',
  IMAGE: 'IMAGE',
  IMAGE_DESCRIPTION: 'IMAGE_DESCRIPTION',
  TRANSCRIPTION: 'TRANSCRIPTION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  AUDIO: 'AUDIO',
  VIDEO: 'VIDEO',
  OBJECT_SMALL: 'OBJECT_SMALL',
  OBJECT_LARGE: 'OBJECT_LARGE',
} as const;

export type ServiceTypeName = (typeof ServiceType)[keyof typeof ServiceType];

export const ServiceType = {
  TRANSCRIPTION: 'transcription',
  VIDEO: 'video',
  BROWSER: 'browser',
  PDF: 'pdf',
  REMOTE_FILES: 'aws_s3',
  WEB_SEARCH: 'web_search',
  EMAIL: 'email',
  TEE: 'tee',
  TASK: 'task',
} as const;

/**
 * Represents the current state/context of a conversation
 */
export interface State {
  /** Additional dynamic properties */
  [key: string]: any;
  values: {
    [key: string]: any;
  };
  data: {
    [key: string]: any;
  };
  text: string;
}

/**
 * Memory type enumeration for built-in memory types
 */
export type MemoryTypeAlias = string;

export enum MemoryType {
  DOCUMENT = 'document',
  FRAGMENT = 'fragment',
  MESSAGE = 'message',
  DESCRIPTION = 'description',
  CUSTOM = 'custom',
}
export type MemoryScope = 'shared' | 'private' | 'room';

/**
 * Base interface for all memory metadata types
 */
export interface BaseMetadata {
  type: MemoryTypeAlias;
  source?: string;
  sourceId?: UUID;
  scope?: MemoryScope;
  timestamp?: number;
  tags?: string[];
}

export interface DocumentMetadata extends BaseMetadata {
  type: MemoryType.DOCUMENT;
}

export interface FragmentMetadata extends BaseMetadata {
  type: MemoryType.FRAGMENT;
  documentId: UUID;
  position: number;
}

export interface MessageMetadata extends BaseMetadata {
  type: MemoryType.MESSAGE;
}

export interface DescriptionMetadata extends BaseMetadata {
  type: MemoryType.DESCRIPTION;
}

export interface CustomMetadata extends BaseMetadata {
  [key: string]: unknown;
}

export type MemoryMetadata =
  | DocumentMetadata
  | FragmentMetadata
  | MessageMetadata
  | DescriptionMetadata
  | CustomMetadata;

/**
 * Represents a stored memory/message
 */
export interface Memory {
  /** Optional unique identifier */
  id?: UUID;

  /** Associated user ID */
  entityId: UUID;

  /** Associated agent ID */
  agentId?: UUID;

  /** Optional creation timestamp in milliseconds since epoch */
  createdAt?: number;

  /** Memory content */
  content: Content;

  /** Optional embedding vector for semantic search */
  embedding?: number[];

  /** Associated room ID */
  roomId: UUID;

  /** Whether memory is unique (used to prevent duplicates) */
  unique?: boolean;

  /** Embedding similarity score (set when retrieved via search) */
  similarity?: number;

  /** Metadata for the memory */
  metadata?: MemoryMetadata;
}

/**
 * Represents a log entry
 */
export interface Log {
  /** Optional unique identifier */
  id?: UUID;

  /** Associated entity ID */
  entityId: UUID;

  /** Associated room ID */
  roomId?: UUID;

  /** Log body */
  body: { [key: string]: unknown };

  /** Log type */
  type: string;

  /** Log creation timestamp */
  createdAt: Date;
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

/**
 * Handler function type for processing messages
 */
export type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: { [key: string]: unknown },
  callback?: HandlerCallback,
  responses?: Memory[]
) => Promise<unknown>;

/**
 * Callback function type for handlers
 */
export type HandlerCallback = (response: Content, files?: any) => Promise<Memory[]>;

/**
 * Validator function type for actions/evaluators
 */
export type Validator = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
) => Promise<boolean>;

/**
 * Represents an action the agent can perform
 */
export interface Action {
  /** Similar action descriptions */
  similes?: string[];

  /** Detailed description */
  description: string;

  /** Example usages */
  examples?: ActionExample[][];

  /** Handler function */
  handler: Handler;

  /** Action name */
  name: string;

  /** Validation function */
  validate: Validator;
}

/**
 * Example for evaluating agent behavior
 */
export interface EvaluationExample {
  /** Evaluation context */
  prompt: string;

  /** Example messages */
  messages: Array<ActionExample>;

  /** Expected outcome */
  outcome: string;
}

/**
 * Evaluator for assessing agent responses
 */
export interface Evaluator {
  /** Whether to always run */
  alwaysRun?: boolean;

  /** Detailed description */
  description: string;

  /** Similar evaluator descriptions */
  similes?: string[];

  /** Example evaluations */
  examples: EvaluationExample[];

  /** Handler function */
  handler: Handler;

  /** Evaluator name */
  name: string;

  /** Validation function */
  validate: Validator;
}

export interface ProviderResult {
  values?: {
    [key: string]: any;
  };
  data?: {
    [key: string]: any;
  };
  text?: string;
}

/**
 * Provider for external data/services
 */
export interface Provider {
  /** Provider name */
  name: string;

  /** Description of the provider */
  description?: string;

  /** Whether the provider is dynamic */
  dynamic?: boolean;

  /** Position of the provider in the provider list, positive or negative */
  position?: number;

  /**
   * Whether the provider is private
   *
   * Private providers are not displayed in the regular provider list, they have to be called explicitly
   */
  private?: boolean;

  /** Data retrieval function */
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}

/**
 * Represents a relationship between users
 */
export interface Relationship {
  /** Unique identifier */
  id: UUID;

  /** First user ID */
  sourceEntityId: UUID;

  /** Second user ID */
  targetEntityId: UUID;

  /** Agent ID */
  agentId: UUID;

  /** Tags for filtering/categorizing relationships */
  tags: string[];

  /** Additional metadata about the relationship */
  metadata: {
    [key: string]: any;
  };

  /** Optional creation timestamp */
  createdAt?: string;
}

export interface Component {
  id: UUID;
  entityId: UUID;
  agentId: UUID;
  roomId: UUID;
  worldId: UUID;
  sourceEntityId: UUID;
  type: string;
  data: {
    [key: string]: any;
  };
}

/**
 * Represents a user account
 */
export interface Entity {
  /** Unique identifier, optional on creation */
  id?: UUID;

  /** Names of the entity */
  names: string[];

  /** Optional additional metadata */
  metadata?: { [key: string]: any };

  /** Agent ID this account is related to, for agents should be themselves */
  agentId: UUID;

  /** Optional array of components */
  components?: Component[];
}

export type World = {
  id: UUID;
  name?: string;
  agentId: UUID;
  serverId: string;
  metadata?: {
    ownership?: {
      ownerId: string;
    };
    roles?: {
      [entityId: UUID]: Role;
    };
    [key: string]: unknown;
  };
};

export type Room = {
  id: UUID;
  name?: string;
  agentId?: UUID;
  source: string;
  type: ChannelType;
  channelId?: string;
  serverId?: string;
  worldId?: UUID;
  metadata?: Record<string, unknown>;
};

/**
 * Room participant with account details
 */
export interface Participant {
  /** Unique identifier */
  id: UUID;

  /** Associated account */
  entity: Entity;
}

/**
 * Represents a media attachment
 */
export type Media = {
  /** Unique identifier */
  id: string;

  /** Media URL */
  url: string;

  /** Media title */
  title: string;

  /** Media source */
  source: string;

  /** Media description */
  description: string;

  /** Text content */
  text: string;

  /** Content type */
  contentType?: string;
};

export enum ChannelType {
  SELF = 'SELF', // Messages to self
  DM = 'dm', // Direct messages between two participants
  GROUP = 'group', // Group messages with multiple participants
  VOICE_DM = 'VOICE_DM', // Voice direct messages
  VOICE_GROUP = 'VOICE_GROUP', // Voice channels with multiple participants
  FEED = 'FEED', // Social media feed
  THREAD = 'THREAD', // Threaded conversation
  WORLD = 'WORLD', // World channel
  FORUM = 'FORUM', // Forum discussion
  // Legacy types - kept for backward compatibility but should be replaced
  API = 'API', // @deprecated - Use DM or GROUP instead
}

/**
 * Client instance
 */
export abstract class Service {
  /** Runtime instance */
  protected runtime!: IAgentRuntime;

  constructor(runtime?: IAgentRuntime) {
    if (runtime) {
      this.runtime = runtime;
    }
  }

  abstract stop(): Promise<void>;

  /** Service type */
  static serviceType: string;

  /** Service name */
  abstract capabilityDescription: string;

  /** Service configuration */
  config?: { [key: string]: any };

  /** Start service connection */
  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error('Not implemented');
  }

  /** Stop service connection */
  static async stop(_runtime: IAgentRuntime): Promise<unknown> {
    throw new Error('Not implemented');
  }
}

export type Route = {
  type: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'STATIC';
  path: string;
  filePath?: string;
  handler?: (req: any, res: any, runtime: IAgentRuntime) => Promise<void>;
};

/**
 * Plugin for extending agent functionality
 */
export interface Plugin {
  name: string;
  description: string;

  // Initialize plugin with runtime services
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;

  // Configuration
  config?: { [key: string]: any };

  services?: (typeof Service)[];

  // Entity component definitions
  componentTypes?: {
    name: string;
    schema: Record<string, unknown>;
    validator?: (data: any) => boolean;
  }[];

  // Optional plugin features
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: {
    [key: string]: (...args: any[]) => Promise<any>;
  };
  events?: {
    [K in keyof EventPayloadMap]?: EventHandler<K>[];
  } & {
    [key: string]: ((params: EventPayload) => Promise<any>)[];
  };
  routes?: Route[];
  tests?: TestSuite[];
}

export interface ProjectAgent {
  character: Character;
  init?: (runtime: IAgentRuntime) => Promise<void>;
  plugins?: Plugin[];
  tests?: TestSuite | TestSuite[];
}

export interface Project {
  agents: ProjectAgent[];
}

export type TemplateType =
  | string
  | ((options: { state: State | { [key: string]: string } }) => string);

/**
 * Configuration for an agent character
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
  knowledge?: (string | { path: string; shared?: boolean })[];

  /** Available plugins */
  plugins?: string[];

  /** Optional configuration */
  settings?: {
    [key: string]: any | string | boolean | number;
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

export interface Agent extends Character {
  enabled?: boolean;
  status?: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Interface for database operations
 */
export interface IDatabaseAdapter {
  /** Database instance */
  db: any;

  /** Initialize database connection */
  init(): Promise<void>;

  /** Close database connection */
  close(): Promise<void>;

  getAgent(agentId: UUID): Promise<Agent | null>;

  /** Get all agents */
  getAgents(): Promise<Agent[]>;

  createAgent(agent: Partial<Agent>): Promise<boolean>;

  updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;

  deleteAgent(agentId: UUID): Promise<boolean>;

  ensureAgentExists(agent: Partial<Agent>): Promise<Agent>;

  ensureEmbeddingDimension(dimension: number): Promise<void>;

  /** Get entity by ID */
  getEntityById(entityId: UUID): Promise<Entity | null>;

  /** Get entities for room */
  getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]>;

  /** Create new entity */
  createEntity(entity: Entity): Promise<boolean>;

  /** Update entity */
  updateEntity(entity: Entity): Promise<void>;

  /** Get component by ID */
  getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null>;

  /** Get all components for an entity */
  getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]>;

  /** Create component */
  createComponent(component: Component): Promise<boolean>;

  /** Update component */
  updateComponent(component: Component): Promise<void>;

  /** Delete component */
  deleteComponent(componentId: UUID): Promise<void>;

  /** Get memories matching criteria */
  getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    roomId?: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
  }): Promise<Memory[]>;

  getMemoryById(id: UUID): Promise<Memory | null>;

  getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]>;

  getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
  }): Promise<Memory[]>;

  getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]>;

  log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void>;

  getLogs(params: {
    entityId: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]>;

  deleteLog(logId: UUID): Promise<void>;

  searchMemories(params: {
    embedding: number[];
    match_threshold?: number;
    count?: number;
    roomId?: UUID;
    unique?: boolean;
    tableName: string;
  }): Promise<Memory[]>;

  createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID>;

  updateMemory(memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }): Promise<boolean>;

  deleteMemory(memoryId: UUID): Promise<void>;

  deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;

  countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;

  createWorld(world: World): Promise<UUID>;

  getWorld(id: UUID): Promise<World | null>;

  getAllWorlds(): Promise<World[]>;

  updateWorld(world: World): Promise<void>;

  getRoom(roomId: UUID): Promise<Room | null>;

  createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID>;

  deleteRoom(roomId: UUID): Promise<void>;

  updateRoom(room: Room): Promise<void>;

  getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;

  getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;

  getRooms(worldId: UUID): Promise<Room[]>;

  addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;

  removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;

  getParticipantsForEntity(entityId: UUID): Promise<Participant[]>;

  getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

  getParticipantUserState(roomId: UUID, entityId: UUID): Promise<'FOLLOWED' | 'MUTED' | null>;

  setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void>;

  /**
   * Creates a new relationship between two entities.
   * @param params Object containing the relationship details
   * @returns Promise resolving to boolean indicating success
   */
  createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: any };
  }): Promise<boolean>;

  /**
   * Updates an existing relationship between two entities.
   * @param relationship The relationship object with updated data
   * @returns Promise resolving to void
   */
  updateRelationship(relationship: Relationship): Promise<void>;

  /**
   * Retrieves a relationship between two entities if it exists.
   * @param params Object containing the entity IDs and agent ID
   * @returns Promise resolving to the Relationship object or null if not found
   */
  getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null>;

  /**
   * Retrieves all relationships for a specific entity.
   * @param params Object containing the user ID, agent ID and optional tags to filter by
   * @returns Promise resolving to an array of Relationship objects
   */
  getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]>;

  ensureEmbeddingDimension(dimension: number): Promise<void>;

  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean>;
  deleteCache(key: string): Promise<boolean>;

  // Only task instance methods - definitions are in-memory
  createTask(task: Task): Promise<UUID>;
  getTasks(params: { roomId?: UUID; tags?: string[] }): Promise<Task[]>;
  getTask(id: UUID): Promise<Task | null>;
  getTasksByName(name: string): Promise<Task[]>;
  updateTask(id: UUID, task: Partial<Task>): Promise<void>;
  deleteTask(id: UUID): Promise<void>;
}

/**
 * Result interface for embedding similarity searches
 */
export interface EmbeddingSearchResult {
  embedding: number[];
  levenshtein_score: number;
}

/**
 * Options for memory retrieval operations
 */
export interface MemoryRetrievalOptions {
  roomId: UUID;
  count?: number;
  unique?: boolean;
  start?: number;
  end?: number;
  agentId?: UUID;
}

/**
 * Options for memory search operations
 */
export interface MemorySearchOptions {
  embedding: number[];
  match_threshold?: number;
  count?: number;
  roomId: UUID;
  agentId?: UUID;
  unique?: boolean;
  metadata?: Partial<MemoryMetadata>;
}

/**
 * Options for multi-room memory retrieval
 */
export interface MultiRoomMemoryOptions {
  roomIds: UUID[];
  limit?: number;
  agentId?: UUID;
}

/**
 * Unified options pattern for memory operations
 * Provides a simpler, more consistent interface
 */
export interface UnifiedMemoryOptions {
  roomId: UUID;
  limit?: number; // Unified naming (replacing 'count')
  agentId?: UUID; // Common optional parameter
  unique?: boolean; // Common flag for duplication control
  start?: number; // Pagination start
  end?: number; // Pagination end
}

/**
 * Specialized memory search options
 */
export interface UnifiedSearchOptions extends UnifiedMemoryOptions {
  embedding: number[];
  similarity?: number; // Clearer name than 'match_threshold'
}

export interface IAgentRuntime extends IDatabaseAdapter {
  // Properties
  agentId: UUID;
  character: Character;
  providers: Provider[];
  actions: Action[];
  evaluators: Evaluator[];
  plugins: Plugin[];
  services: Map<ServiceTypeName, Service>;
  events: Map<string, ((params: any) => Promise<void>)[]>;
  fetch?: typeof fetch | null;
  routes: Route[];

  // Methods
  registerPlugin(plugin: Plugin): Promise<void>;

  initialize(): Promise<void>;

  getKnowledge(message: Memory): Promise<KnowledgeItem[]>;
  addKnowledge(
    item: KnowledgeItem,
    options: {
      targetTokens: number;
      overlap: number;
      modelContextSize: number;
    }
  ): Promise<void>;

  getService<T extends Service>(service: ServiceTypeName | string): T | null;

  getAllServices(): Map<ServiceTypeName, Service>;

  registerService(service: typeof Service): Promise<void>;

  // Keep these methods for backward compatibility
  registerDatabaseAdapter(adapter: IDatabaseAdapter): void;

  setSetting(key: string, value: string | boolean | null | any, secret: boolean): void;

  getSetting(key: string): string | boolean | null | any;

  getConversationLength(): number;

  processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void>;

  evaluate(
    message: Memory,
    state?: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<Evaluator[] | null>;

  registerProvider(provider: Provider): void;

  registerAction(action: Action): void;

  registerEvaluator(evaluator: Evaluator): void;

  ensureConnection({
    entityId,
    roomId,
    userName,
    name,
    source,
    channelId,
    serverId,
    type,
    worldId,
    userId,
  }: {
    entityId: UUID;
    roomId: UUID;
    userName?: string;
    name?: string;
    source?: string;
    channelId?: string;
    serverId?: string;
    type: ChannelType;
    worldId?: UUID;
    userId?: UUID;
  }): Promise<void>;

  ensureParticipantInRoom(entityId: UUID, roomId: UUID): Promise<void>;

  ensureWorldExists(world: World): Promise<void>;

  ensureRoomExists(room: Room): Promise<void>;

  composeState(message: Memory, filterList?: string[], includeList?: string[]): Promise<State>;

  /**
   * Use a model with strongly typed parameters and return values based on model type
   * @template T - The model type to use
   * @template R - The expected return type, defaults to the type defined in ModelResultMap[T]
   * @param {T} modelType - The type of model to use
   * @param {ModelParamsMap[T] | any} params - The parameters for the model, typed based on model type
   * @returns {Promise<R>} - The model result, typed based on the provided generic type parameter
   */
  useModel<T extends ModelTypeName, R = ModelResultMap[T]>(
    modelType: T,
    params: Omit<ModelParamsMap[T], 'runtime'> | any
  ): Promise<R>;

  registerModel(modelType: ModelTypeName | string, handler: (params: any) => Promise<any>): void;

  getModel(
    modelType: ModelTypeName | string
  ): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined;

  registerEvent(event: string, handler: (params: any) => Promise<void>): void;

  getEvent(event: string): ((params: any) => Promise<void>)[] | undefined;

  emitEvent(event: string | string[], params: any): Promise<void>;

  // In-memory task definition methods
  registerTaskWorker(taskHandler: TaskWorker): void;
  getTaskWorker(name: string): TaskWorker | undefined;

  stop(): Promise<void>;

  addEmbeddingToMemory(memory: Memory): Promise<Memory>;
}

/**
 * Interface for settings object with key-value pairs.
 */
/**
 * Interface representing settings with string key-value pairs.
 */
export interface RuntimeSettings {
  [key: string]: string | undefined;
}

export type KnowledgeItem = {
  id: UUID;
  content: Content;
  metadata?: MemoryMetadata;
};

export enum KnowledgeScope {
  SHARED = 'shared',
  PRIVATE = 'private',
}

export enum CacheKeyPrefix {
  KNOWLEDGE = 'knowledge',
}

export interface DirectoryItem {
  directory: string;
  shared?: boolean;
}

export interface ChunkRow {
  id: string;
  // Add other properties if needed
}

export type GenerateTextParams = {
  runtime: IAgentRuntime;
  prompt: string;
  modelType: ModelTypeName;
  maxTokens?: number;
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
};

export interface TokenizeTextParams {
  prompt: string;
  modelType: ModelTypeName;
}

export interface DetokenizeTextParams {
  tokens: number[];
  modelType: ModelTypeName;
}

export interface IVideoService extends Service {
  isVideoUrl(url: string): boolean;
  fetchVideoInfo(url: string): Promise<Media>;
  downloadVideo(videoInfo: Media): Promise<string>;
  processVideo(url: string, runtime: IAgentRuntime): Promise<Media>;
}

export interface IBrowserService extends Service {
  getPageContent(
    url: string,
    runtime: IAgentRuntime
  ): Promise<{ title: string; description: string; bodyContent: string }>;
}

export interface IPdfService extends Service {
  convertPdfToText(pdfBuffer: Buffer): Promise<string>;
}

export interface IFileService extends Service {
  uploadFile(
    imagePath: string,
    subDirectory: string,
    useSignedUrl: boolean,
    expiresIn: number
  ): Promise<{
    success: boolean;
    url?: string;
    error?: string;
  }>;
  generateSignedUrl(fileName: string, expiresIn: number): Promise<string>;
}

export interface TestCase {
  name: string;
  fn: (runtime: IAgentRuntime) => Promise<void> | void;
}

export interface TestSuite {
  name: string;
  tests: TestCase[];
}

// Represents an agent in the TeeAgent table, containing details about the agent.
export interface TeeAgent {
  id: string; // Primary key
  // Allow duplicate agentId.
  // This is to support the case where the same agentId is registered multiple times.
  // Each time the agent restarts, we will generate a new keypair and attestation.
  agentId: string;
  agentName: string;
  createdAt: number;
  publicKey: string;
  attestation: string;
}

export enum TEEMode {
  OFF = 'OFF',
  LOCAL = 'LOCAL', // For local development with simulator
  DOCKER = 'DOCKER', // For docker development with simulator
  PRODUCTION = 'PRODUCTION', // For production without simulator
}

export interface RemoteAttestationQuote {
  quote: string;
  timestamp: number;
}

export interface DeriveKeyAttestationData {
  agentId: string;
  publicKey: string;
  subject?: string;
}

export interface RemoteAttestationMessage {
  agentId: string;
  timestamp: number;
  message: {
    entityId: string;
    roomId: string;
    content: string;
  };
}

export enum TeeType {
  TDX_DSTACK = 'tdx_dstack',
}

export interface TeeVendorConfig {
  // Add vendor-specific configuration options here
  [key: string]: unknown;
}

export interface TeePluginConfig {
  vendor?: string;
  vendorConfig?: TeeVendorConfig;
}

export interface TaskWorker {
  name: string;
  execute: (
    runtime: IAgentRuntime,
    options: { [key: string]: unknown },
    task: Task
  ) => Promise<void>;
  validate?: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<boolean>;
}

export interface Task {
  id?: UUID;
  name: string;
  updatedAt?: number;
  metadata?: {
    updateInterval?: number;
    options?: {
      name: string;
      description: string;
    }[];
    [key: string]: unknown;
  };
  description: string;
  roomId?: UUID;
  worldId?: UUID;
  tags: string[];
}

export enum Role {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  NONE = 'NONE',
}

export interface Setting {
  name: string;
  description: string; // Used in chat context when discussing the setting
  usageDescription: string; // Used during settings to guide users
  value: string | boolean | null;
  required: boolean;
  public?: boolean; // If true, shown in public channels
  secret?: boolean; // If true, value is masked and only shown during settings
  validation?: (value: any) => boolean;
  dependsOn?: string[];
  onSetAction?: (value: any) => string;
  visibleIf?: (settings: { [key: string]: Setting }) => boolean;
}

export interface WorldSettings {
  [key: string]: Setting;
}

export interface OnboardingConfig {
  settings: {
    [key: string]: Omit<Setting, 'value'>;
  };
}

/**
 * Base parameters common to all model types
 */
export interface BaseModelParams {
  /** The agent runtime for accessing services and utilities */
  runtime: IAgentRuntime;
}

/**
 * Parameters for text generation models
 */
export interface TextGenerationParams extends BaseModelParams {
  /** The prompt to generate text from */
  prompt: string;
  /** Model temperature (0.0 to 1.0, lower is more deterministic) */
  temperature?: number;
  /** Maximum number of tokens to generate */
  maxTokens?: number;
  /** Sequences that should stop generation when encountered */
  stopSequences?: string[];
  /** Frequency penalty to apply */
  frequencyPenalty?: number;
  /** Presence penalty to apply */
  presencePenalty?: number;
}

/**
 * Parameters for text embedding models
 */
export interface TextEmbeddingParams extends BaseModelParams {
  /** The text to create embeddings for */
  text: string;
}

/**
 * Parameters for text tokenization models
 */
export interface TokenizeTextParams extends BaseModelParams {
  /** The text to tokenize */
  prompt: string;
  /** The model type to use for tokenization */
  modelType: ModelTypeName;
}

/**
 * Parameters for text detokenization models
 */
export interface DetokenizeTextParams extends BaseModelParams {
  /** The tokens to convert back to text */
  tokens: number[];
  /** The model type to use for detokenization */
  modelType: ModelTypeName;
}

/**
 * Parameters for image generation models
 */
export interface ImageGenerationParams extends BaseModelParams {
  /** The prompt describing the image to generate */
  prompt: string;
  /** The dimensions of the image to generate */
  size?: string;
  /** Number of images to generate */
  count?: number;
}

/**
 * Parameters for image description models
 */
export interface ImageDescriptionParams extends BaseModelParams {
  /** The URL or path of the image to describe */
  imageUrl: string;
  /** Optional prompt to guide the description */
  prompt?: string;
}

/**
 * Parameters for transcription models
 */
export interface TranscriptionParams extends BaseModelParams {
  /** The URL or path of the audio file to transcribe */
  audioUrl: string;
  /** Optional prompt to guide transcription */
  prompt?: string;
}

/**
 * Parameters for text-to-speech models
 */
export interface TextToSpeechParams extends BaseModelParams {
  /** The text to convert to speech */
  text: string;
  /** The voice to use */
  voice?: string;
  /** The speaking speed */
  speed?: number;
}

/**
 * Parameters for audio processing models
 */
export interface AudioProcessingParams extends BaseModelParams {
  /** The URL or path of the audio file to process */
  audioUrl: string;
  /** The type of audio processing to perform */
  processingType: string;
}

/**
 * Parameters for video processing models
 */
export interface VideoProcessingParams extends BaseModelParams {
  /** The URL or path of the video file to process */
  videoUrl: string;
  /** The type of video processing to perform */
  processingType: string;
}

/**
 * Optional JSON schema for validating generated objects
 */
export type JSONSchema = {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  items?: JSONSchema;
  [key: string]: any;
};

/**
 * Parameters for object generation models
 * @template T - The expected return type, inferred from schema if provided
 */
export interface ObjectGenerationParams<T = any> extends BaseModelParams {
  /** The prompt describing the object to generate */
  prompt: string;
  /** Optional JSON schema for validation */
  schema?: JSONSchema;
  /** Type of object to generate */
  output?: 'object' | 'array' | 'enum';
  /** For enum type, the allowed values */
  enumValues?: string[];
  /** Model type to use */
  modelType?: ModelTypeName;
  /** Model temperature (0.0 to 1.0) */
  temperature?: number;
  /** Sequences that should stop generation */
  stopSequences?: string[];
}

/**
 * Map of model types to their parameter types
 */
export interface ModelParamsMap {
  [ModelType.TEXT_SMALL]: TextGenerationParams;
  [ModelType.TEXT_LARGE]: TextGenerationParams;
  [ModelType.TEXT_EMBEDDING]: TextEmbeddingParams | string | null;
  [ModelType.TEXT_TOKENIZER_ENCODE]: TokenizeTextParams;
  [ModelType.TEXT_TOKENIZER_DECODE]: DetokenizeTextParams;
  [ModelType.TEXT_REASONING_SMALL]: TextGenerationParams;
  [ModelType.TEXT_REASONING_LARGE]: TextGenerationParams;
  [ModelType.IMAGE]: ImageGenerationParams;
  [ModelType.IMAGE_DESCRIPTION]: ImageDescriptionParams | string;
  [ModelType.TRANSCRIPTION]: TranscriptionParams | Buffer | string;
  [ModelType.TEXT_TO_SPEECH]: TextToSpeechParams | string;
  [ModelType.AUDIO]: AudioProcessingParams;
  [ModelType.VIDEO]: VideoProcessingParams;
  [ModelType.OBJECT_SMALL]: ObjectGenerationParams<any>;
  [ModelType.OBJECT_LARGE]: ObjectGenerationParams<any>;
  // Allow string index for custom model types
  [key: string]: BaseModelParams | any;
}

/**
 * Map of model types to their return value types
 */
export interface ModelResultMap {
  [ModelType.TEXT_SMALL]: string;
  [ModelType.TEXT_LARGE]: string;
  [ModelType.TEXT_EMBEDDING]: number[];
  [ModelType.TEXT_TOKENIZER_ENCODE]: number[];
  [ModelType.TEXT_TOKENIZER_DECODE]: string;
  [ModelType.TEXT_REASONING_SMALL]: string;
  [ModelType.TEXT_REASONING_LARGE]: string;
  [ModelType.IMAGE]: { url: string }[];
  [ModelType.IMAGE_DESCRIPTION]: { title: string; description: string };
  [ModelType.TRANSCRIPTION]: string;
  [ModelType.TEXT_TO_SPEECH]: any | Buffer;
  [ModelType.AUDIO]: any; // Specific return type depends on processing type
  [ModelType.VIDEO]: any; // Specific return type depends on processing type
  [ModelType.OBJECT_SMALL]: any;
  [ModelType.OBJECT_LARGE]: any;
  // Allow string index for custom model types
  [key: string]: any;
}

/**
 * Standard event types across all platforms
 */
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
}

/**
 * Platform-specific event type prefix
 */
export enum PlatformPrefix {
  DISCORD = 'DISCORD',
  TELEGRAM = 'TELEGRAM',
  TWITTER = 'TWITTER',
}

/**
 * Base payload interface for all events
 */
export interface EventPayload {
  runtime: IAgentRuntime;
  source: string;
  onComplete?: () => void;
}

/**
 * Payload for world-related events
 */
export interface WorldPayload extends EventPayload {
  world: World;
  rooms: Room[];
  entities: Entity[];
}

/**
 * Payload for entity-related events
 */
export interface EntityPayload extends EventPayload {
  entityId: UUID;
  worldId?: UUID;
  roomId?: UUID;
  metadata?: {
    orginalId: string;
    username: string;
    displayName?: string;
    [key: string]: any;
  };
}

/**
 * Payload for reaction-related events
 */
export interface MessagePayload extends EventPayload {
  message: Memory;
  callback?: HandlerCallback;
  onComplete?: () => void;
}

/**
 * Payload for events that are invoked without a message
 */
export interface InvokePayload extends EventPayload {
  worldId: UUID;
  userId: string;
  roomId: UUID;
  callback?: HandlerCallback;
  source: string;
}

/**
 * Run event payload type
 */
export interface RunEventPayload extends EventPayload {
  runId: UUID;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  startTime: number;
  status: 'started' | 'completed' | 'timeout';
  endTime?: number;
  duration?: number;
  error?: string;
}

/**
 * Action event payload type
 */
export interface ActionEventPayload extends EventPayload {
  actionId: UUID;
  actionName: string;
  startTime?: number;
  completed?: boolean;
  error?: Error;
}

/**
 * Evaluator event payload type
 */
export interface EvaluatorEventPayload extends EventPayload {
  evaluatorId: UUID;
  evaluatorName: string;
  startTime?: number;
  completed?: boolean;
  error?: Error;
}

/**
 * Represents the parameters for a message received handler.
 * @typedef {Object} MessageReceivedHandlerParams
 * @property {IAgentRuntime} runtime - The agent runtime associated with the message.
 * @property {Memory} message - The message received.
 * @property {HandlerCallback} callback - The callback function to be executed after handling the message.
 */
export type MessageReceivedHandlerParams = {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback;
  onComplete?: () => void;
};

/**
 * Maps event types to their corresponding payload types
 */
export interface EventPayloadMap {
  [EventType.WORLD_JOINED]: WorldPayload;
  [EventType.WORLD_CONNECTED]: WorldPayload;
  [EventType.WORLD_LEFT]: WorldPayload;
  [EventType.ENTITY_JOINED]: EntityPayload;
  [EventType.ENTITY_LEFT]: EntityPayload;
  [EventType.ENTITY_UPDATED]: EntityPayload;
  [EventType.MESSAGE_RECEIVED]: MessagePayload;
  [EventType.MESSAGE_SENT]: MessagePayload;
  [EventType.REACTION_RECEIVED]: MessagePayload;
  [EventType.POST_GENERATED]: InvokePayload;
  [EventType.INTERACTION_RECEIVED]: MessagePayload;
  [EventType.RUN_STARTED]: RunEventPayload;
  [EventType.RUN_ENDED]: RunEventPayload;
  [EventType.RUN_TIMEOUT]: RunEventPayload;
  [EventType.ACTION_STARTED]: ActionEventPayload;
  [EventType.ACTION_COMPLETED]: ActionEventPayload;
  [EventType.EVALUATOR_STARTED]: EvaluatorEventPayload;
  [EventType.EVALUATOR_COMPLETED]: EvaluatorEventPayload;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends keyof EventPayloadMap> = (
  payload: EventPayloadMap[T]
) => Promise<void>;

/**
 * Update the Plugin interface with typed events
 */

export enum SOCKET_MESSAGE_TYPE {
  ROOM_JOINING = 1,
  SEND_MESSAGE = 2,
  MESSAGE = 3,
  ACK = 4,
  THINKING = 5,
  CONTROL = 6,
}

/**
 * Specialized memory type for messages with enhanced type checking
 */
export interface MessageMemory extends Memory {
  metadata: MessageMetadata;
  content: Content & {
    text: string; // Message memories must have text content
  };
}

/**
 * Factory function to create a new message memory with proper defaults
 */
export function createMessageMemory(params: {
  id?: UUID;
  entityId: UUID;
  agentId?: UUID;
  roomId: UUID;
  content: Content & { text: string };
  embedding?: number[];
}): MessageMemory {
  return {
    ...params,
    createdAt: Date.now(),
    metadata: {
      type: MemoryType.MESSAGE,
      timestamp: Date.now(),
      scope: params.agentId ? 'private' : 'shared',
    },
  };
}

/**
 * Generic service interface that provides better type checking for services
 * @template ConfigType The configuration type for this service
 * @template ResultType The result type returned by the service operations
 */
export interface TypedService<ConfigType = unknown, ResultType = unknown> extends Service {
  /**
   * The configuration for this service instance
   */
  config: ConfigType;

  /**
   * Process an input with this service
   * @param input The input to process
   * @returns A promise resolving to the result
   */
  process(input: unknown): Promise<ResultType>;
}

/**
 * Generic factory function to create a typed service instance
 * @param runtime The agent runtime
 * @param serviceType The type of service to get
 * @returns The service instance or null if not available
 */
export function getTypedService<T extends TypedService<any, any>>(
  runtime: IAgentRuntime,
  serviceType: ServiceTypeName
): T | null {
  return runtime.getService<T>(serviceType);
}

/**
 * Type guard to check if a memory metadata is a DocumentMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a DocumentMetadata
 */
export function isDocumentMetadata(metadata: MemoryMetadata): metadata is DocumentMetadata {
  return metadata.type === MemoryType.DOCUMENT;
}

/**
 * Type guard to check if a memory metadata is a FragmentMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a FragmentMetadata
 */
export function isFragmentMetadata(metadata: MemoryMetadata): metadata is FragmentMetadata {
  return metadata.type === MemoryType.FRAGMENT;
}

/**
 * Type guard to check if a memory metadata is a MessageMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a MessageMetadata
 */
export function isMessageMetadata(metadata: MemoryMetadata): metadata is MessageMetadata {
  return metadata.type === MemoryType.MESSAGE;
}

/**
 * Type guard to check if a memory metadata is a DescriptionMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a DescriptionMetadata
 */
export function isDescriptionMetadata(metadata: MemoryMetadata): metadata is DescriptionMetadata {
  return metadata.type === MemoryType.DESCRIPTION;
}

/**
 * Type guard to check if a memory metadata is a CustomMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a CustomMetadata
 */
export function isCustomMetadata(metadata: MemoryMetadata): metadata is CustomMetadata {
  return (
    metadata.type !== MemoryType.DOCUMENT &&
    metadata.type !== MemoryType.FRAGMENT &&
    metadata.type !== MemoryType.MESSAGE &&
    metadata.type !== MemoryType.DESCRIPTION
  );
}

/**
 * Standardized service error type for consistent error handling
 */
export interface ServiceError {
  code: string;
  message: string;
  details?: unknown;
  cause?: Error;
}

/**
 * Type-safe helper for accessing the video service
 */
export function getVideoService(runtime: IAgentRuntime): IVideoService | null {
  return runtime.getService<IVideoService>(ServiceType.VIDEO);
}

/**
 * Type-safe helper for accessing the browser service
 */
export function getBrowserService(runtime: IAgentRuntime): IBrowserService | null {
  return runtime.getService<IBrowserService>(ServiceType.BROWSER);
}

/**
 * Type-safe helper for accessing the PDF service
 */
export function getPdfService(runtime: IAgentRuntime): IPdfService | null {
  return runtime.getService<IPdfService>(ServiceType.PDF);
}

/**
 * Type-safe helper for accessing the file service
 */
export function getFileService(runtime: IAgentRuntime): IFileService | null {
  return runtime.getService<IFileService>(ServiceType.REMOTE_FILES);
}

/**
 * Memory type guard for document memories
 */
export function isDocumentMemory(
  memory: Memory
): memory is Memory & { metadata: DocumentMetadata } {
  return memory.metadata?.type === MemoryType.DOCUMENT;
}

/**
 * Memory type guard for fragment memories
 */
export function isFragmentMemory(
  memory: Memory
): memory is Memory & { metadata: FragmentMetadata } {
  return memory.metadata?.type === MemoryType.FRAGMENT;
}

/**
 * Safely access the text content of a memory
 * @param memory The memory to extract text from
 * @param defaultValue Optional default value if no text is found
 * @returns The text content or default value
 */
export function getMemoryText(memory: Memory, defaultValue = ''): string {
  return memory.content.text ?? defaultValue;
}

/**
 * Safely create a ServiceError from any caught error
 */
export function createServiceError(error: unknown, code = 'UNKNOWN_ERROR'): ServiceError {
  if (error instanceof Error) {
    return {
      code,
      message: error.message,
      cause: error,
    };
  }

  return {
    code,
    message: String(error),
  };
}

/**
 * Replace 'any' types with more specific types
 */

// Replace 'any' in State interface components
export type StateValue = string | number | boolean | null | StateObject | StateArray;
export interface StateObject {
  [key: string]: StateValue;
}
export type StateArray = StateValue[];

/**
 * Enhanced State interface with more specific types
 */
export interface EnhancedState {
  values: StateObject;
  data: StateObject;
  text: string;
  [key: string]: StateValue;
}

// Replace 'any' in component data
export type ComponentData = Record<string, unknown>;

// Replace 'any' in event handlers
export type EventDataObject = Record<string, unknown>;
export type TypedEventHandler = (data: EventDataObject) => Promise<void> | void;

// Replace 'any' in database adapter
export type DbConnection = unknown;
export type MetadataObject = Record<string, unknown>;

// Replace 'any' in model handlers
export type ModelHandler = (
  runtime: IAgentRuntime,
  params: Record<string, unknown>
) => Promise<unknown>;

// Replace 'any' for service configurationa
export type ServiceConfig = Record<string, unknown>;

// Allowable vector dimensions
export const VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
} as const;

/**
 * Interface for control messages sent from the backend to the frontend
 * to manage UI state and interaction capabilities
 */
export interface ControlMessage {
  /** Message type identifier */
  type: 'control';

  /** Control message payload */
  payload: {
    /** Action to perform */
    action: 'disable_input' | 'enable_input';

    /** Optional target element identifier */
    target?: string;

    /** Additional optional parameters */
    [key: string]: unknown;
  };

  /** Room ID to ensure signal is directed to the correct chat window */
  roomId: UUID;
}
