import { AgentRuntime as coreAgentRuntime } from '@elizaos/core-plugin-v2';
import {
  type Character,
  type Goal,
  type HandlerCallback,
  type IAgentRuntime,
  type ICacheManager,
  type IDatabaseAdapter,
  type IMemoryManager,
  type IRAGKnowledgeManager,
  // type IVerifiableInferenceAdapter,
  type KnowledgeItem,
  // RAGKnowledgeItem,
  //Media,
  ModelClass,
  ModelProviderName,
  type Plugin,
  type Provider,
  type Adapter,
  type Service,
  type ServiceType,
  type State,
  type UUID,
  type Action,
  type Actor,
  type Evaluator,
  type Memory,
  type DirectoryItem,
  type ClientInstance,
} from './types.ts';

import { formatMessages } from './messages.ts';

export class AgentRuntime implements IAgentRuntime {
  private _runtime;
  registerMemoryManager(manager: IMemoryManager): void {
    // WRITE ME
  }
  getMemoryManager(tableName: string): IMemoryManager | null {
    // WRITE ME
  }
  getService<T extends Service>(service: ServiceType): T | null {
    return this._runtime.getService(service);
  }
  async registerService(service: Service): Promise<void> {
    return this._runtime.registerService(service);
  }

  /**
   * Creates an instance of AgentRuntime.
   * @param opts - The options for configuring the AgentRuntime.
   * @param opts.conversationLength - The number of messages to hold in the recent message cache.
   * @param opts.token - The JWT token, can be a JWT token if outside worker, or an OpenAI token if inside worker.
   * @param opts.serverUrl - The URL of the worker.
   * @param opts.actions - Optional custom actions.
   * @param opts.evaluators - Optional custom evaluators.
   * @param opts.services - Optional custom services.
   * @param opts.memoryManagers - Optional custom memory managers.
   * @param opts.providers - Optional context providers.
   * @param opts.model - The model to use for generateText.
   * @param opts.embeddingModel - The model to use for embedding.
   * @param opts.agentId - Optional ID of the agent.
   * @param opts.databaseAdapter - The database adapter used for interacting with the database.
   * @param opts.fetch - Custom fetch function to use for making requests.
   */
  constructor(opts: {
    conversationLength?: number; // number of messages to hold in the recent message cache
    agentId?: UUID; // ID of the agent
    character?: Character; // The character to use for the agent
    token: string; // JWT token, can be a JWT token if outside worker, or an OpenAI token if inside worker
    serverUrl?: string; // The URL of the worker
    actions?: Action[]; // Optional custom actions
    evaluators?: Evaluator[]; // Optional custom evaluators
    plugins?: Plugin[];
    providers?: Provider[];
    modelProvider: ModelProviderName;

    services?: Service[]; // Map of service name to service instance
    managers?: IMemoryManager[]; // Map of table name to memory manager
    databaseAdapter?: IDatabaseAdapter; // The database adapter used for interacting with the database
    fetch?: typeof fetch | unknown;
    speechModelPath?: string;
    cacheManager?: ICacheManager;
    logging?: boolean;
    // verifiableInferenceAdapter?: IVerifiableInferenceAdapter;
  }) {
    this._runtime = new coreAgentRuntime(opts);
  }

  //private async initializeDatabase() {}

  async initialize() {
    return this._runtime.initialize();
  }

  async stop() {
    return this._runtime.stop();
  }

  getSetting(key: string) {
    return this._runtime.getSetting(key);
  }

  /**
   * Get the number of messages that are kept in the conversation buffer.
   * @returns The number of recent messages to be kept in memory.
   */
  getConversationLength() {
    return this._runtime.getConversationLength();
  }

  /**
   * Register an action for the agent to perform.
   * @param action The action to register.
   */
  registerAction(action: Action) {
    return this._runtime.registerAction(action);
  }

  /**
   * Register an evaluator to assess and guide the agent's responses.
   * @param evaluator The evaluator to register.
   */
  registerEvaluator(evaluator: Evaluator) {
    return this._runtime.registerEvaluator(evaluator);
  }

  /**
   * Register a context provider to provide context for message generation.
   * @param provider The context provider to register.
   */
  registerContextProvider(provider: Provider) {
    return this._runtime.registerContextProvider(provider);
  }

  /**
   * Register an adapter for the agent to use.
   * @param adapter The adapter to register.
   */
  registerAdapter(adapter: Adapter) {
    // WRITE ME, maybe...
  }

  /**
   * Process the actions of a message.
   * @param message The message to process.
   * @param content The content of the message to process actions from.
   */
  async processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void> {
    return this._runtime.processActions(message, responses, state, callback);
  }

  /**
   * Evaluate the message and state using the registered evaluators.
   * @param message The message to evaluate.
   * @param state The state of the agent.
   * @param didRespond Whether the agent responded to the message.~
   * @param callback The handler callback
   * @returns The results of the evaluation.
   */
  async evaluate(message: Memory, state: State, didRespond?: boolean, callback?: HandlerCallback) {
    // v2 now takes responses: Memory[]
    return this._runtime.evaluate(message, state, didRespond, callback);
  }

  /**
   * Ensure the existence of a participant in the room. If the participant does not exist, they are added to the room.
   * @param userId - The user ID to ensure the existence of.
   * @throws An error if the participant cannot be added.
   */
  async ensureParticipantExists(userId: UUID, roomId: UUID) {
    // WRITE ME
  }

  /**
   * Ensure the existence of a user in the database. If the user does not exist, they are added to the database.
   * @param userId - The user ID to ensure the existence of.
   * @param userName - The user name to ensure the existence of.
   * @returns
   */
  async ensureUserExists(
    userId: UUID,
    userName: string | null,
    name: string | null,
    email?: string | null,
    source?: string | null
  ) {}

  async ensureParticipantInRoom(userId: UUID, roomId: UUID) {
    return this._runtime.ensureParticipantInRoom(userId, roomId);
  }

  async ensureConnection(
    userId: UUID,
    roomId: UUID,
    userName?: string,
    userScreenName?: string,
    source?: string
  ) {
    return this._runtime.ensureConnection(userId, roomId, userName, userScreenname, source);
  }

  /**
   * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
   * and agent are added as participants. The room ID is returned.
   * @param roomId - The room ID to create a room with.
   * @returns The room ID of the room between the agent and the user.
   * @throws An error if the room cannot be created.
   */
  async ensureRoomExists(roomId: UUID) {
    return this._runtime.ensureRoomExists({
      id: roomId,
      name: 'Unknown',
      source: 'Unknown',
      type: 'Unknown',
      chanenlId: roomId,
      serverId: 0,
      worldId: 0,
      metadata: {},
    });
  }

  /**
   * Compose the state of the agent into an object that can be passed or used for response generation.
   * @param message The message to compose the state from.
   * @returns The state of the agent.
   */
  async composeState(message: Memory, additionalKeys: { [key: string]: unknown } = {}) {
    return this._runtime.composeState(message, [], []);
  }

  async updateRecentMessageState(state: State): Promise<State> {
    const conversationLength = this.getConversationLength();

    // get memories
    this._runtime.getMemories({
      roomId: state.roomId,
      count: conversationLength,
      unique: false,
    });

    // use v1 formatMessage
    const recentMessages = formatMessages({
      actors: state.actorsData ?? [],
      messages: recentMessagesData.map((memory: Memory) => {
        const newMemory = { ...memory };
        delete newMemory.embedding;
        return newMemory;
      }),
    });

    let allAttachments = [];

    if (recentMessagesData && Array.isArray(recentMessagesData)) {
      const lastMessageWithAttachment = recentMessagesData.find(
        (msg) => msg.content.attachments && msg.content.attachments.length > 0
      );

      if (lastMessageWithAttachment) {
        const lastMessageTime = lastMessageWithAttachment?.createdAt ?? Date.now();
        const oneHourBeforeLastMessage = lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

        allAttachments = recentMessagesData
          .filter((msg) => {
            const msgTime = msg.createdAt ?? Date.now();
            return msgTime >= oneHourBeforeLastMessage;
          })
          .flatMap((msg) => msg.content.attachments || []);
      }
    }

    const formattedAttachments = allAttachments
      .map(
        (attachment) =>
          `ID: ${attachment.id}
Name: ${attachment.title}
URL: ${attachment.url}
Type: ${attachment.source}
Description: ${attachment.description}
Text: ${attachment.text}
    `
      )
      .join('\n');

    return {
      ...state,
      recentMessages: addHeader('# Conversation Messages', recentMessages),
      recentMessagesData,
      attachments: formattedAttachments,
    } as State;
  }
}
