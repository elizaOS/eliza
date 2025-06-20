import { addHeader, ChannelType, AgentRuntime as coreAgentRuntime } from '../v2';
import { formatMessages } from './messages';
import {
  type Action,
  type Adapter,
  type Character,
  type Evaluator,
  type HandlerCallback,
  type IAgentRuntime,
  type ICacheManager,
  type IDatabaseAdapter,
  type IMemoryManager,
  type Memory,
  ModelProviderName,
  type Plugin,
  type Provider,
  type Service,
  type ServiceType,
  type State,
  type UUID,
} from './types';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID; // Single default server

export class AgentRuntime implements IAgentRuntime {
  private _runtime;

  get agentId(): UUID {
    return this._runtime.agentId;
  }

  get serverUrl(): string {
    return (this._runtime as any).serverUrl;
  }

  get databaseAdapter(): IDatabaseAdapter {
    return (this._runtime as any).databaseAdapter;
  }

  get token(): string {
    return (this._runtime as any).token;
  }

  get character(): Character {
    return this._runtime.character as any;
  }

  get actions(): Action[] {
    return this._runtime.actions as any;
  }

  get evaluators(): Evaluator[] {
    return this._runtime.evaluators as any;
  }

  get providers(): Provider[] {
    return this._runtime.providers as any;
  }

  get plugins(): Plugin[] {
    return this._runtime.plugins as any;
  }

  get modelProvider() {
    return (this._runtime as any).modelProvider;
  }

  get imageModelProvider() {
    return (this._runtime as any).imageModelProvider;
  }

  get imageVisionModelProvider() {
    return (this._runtime as any).imageVisionModelProvider;
  }

  get messageManager() {
    return (this._runtime as any).messageManager;
  }

  get routes() {
    return this._runtime.routes;
  }

  get services() {
    return (this._runtime as any).services;
  }

  get events() {
    return this._runtime.events;
  }

  get descriptionManager() {
    return (this._runtime as any).descriptionManager;
  }

  get documentsManager() {
    return (this._runtime as any).documentsManager;
  }

  get knowledgeManager() {
    return (this._runtime as any).knowledgeManager;
  }

  get ragKnowledgeManager() {
    return (this._runtime as any).ragKnowledgeManager;
  }

  get loreManager() {
    return (this._runtime as any).loreManager;
  }

  get cacheManager() {
    return (this._runtime as any).cacheManager;
  }

  get clients() {
    return (this._runtime as any).clients;
  }

  registerMemoryManager(_manager: IMemoryManager): void {
    // WRITE ME
  }
  getMemoryManager(_tableName: string): any {
    // WRITE ME
  }
  getService<T extends Service>(service: ServiceType): T | null {
    return this._runtime.getService(service as any) as any;
  }
  async registerService(service: Service): Promise<void> {
    return this._runtime.registerService(service as any);
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
    this._runtime = new coreAgentRuntime(opts as any);
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
    return this._runtime.registerAction(action as any);
  }

  /**
   * Register an evaluator to assess and guide the agent's responses.
   * @param evaluator The evaluator to register.
   */
  registerEvaluator(evaluator: Evaluator) {
    return this._runtime.registerEvaluator(evaluator as any);
  }

  /**
   * Register a context provider to provide context for message generation.
   * @param provider The context provider to register.
   */
  registerContextProvider(provider: Provider) {
    return this._runtime.registerProvider(provider as any);
  }

  /**
   * Register an adapter for the agent to use.
   * @param adapter The adapter to register.
   */
  registerAdapter(_adapter: Adapter) {
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
    return this._runtime.processActions(
      message as any,
      responses as any,
      state as any,
      callback as any
    );
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
    return this._runtime.evaluate(message as any, state as any, didRespond, callback as any);
  }

  /**
   * Ensure the existence of a participant in the room. If the participant does not exist, they are added to the room.
   * @param userId - The user ID to ensure the existence of.
   * @throws An error if the participant cannot be added.
   */
  async ensureParticipantExists(_userId: UUID, _roomId: UUID) {
    // WRITE ME
  }

  /**
   * Ensure the existence of a user in the database. If the user does not exist, they are added to the database.
   * @param userId - The user ID to ensure the existence of.
   * @param userName - The user name to ensure the existence of.
   * @returns
   */
  async ensureUserExists(
    _userId: UUID,
    _userName: string | null,
    _name: string | null,
    _email?: string | null,
    _source?: string | null
  ) {}

  async ensureParticipantInRoom(userId: UUID, roomId: UUID) {
    return this._runtime.ensureParticipantInRoom(userId, roomId);
  }

  async ensureConnection(
    userId: UUID,
    roomId: UUID,
    userName?: string,
    _userScreenName?: string,
    source?: string
  ) {
    return this._runtime.ensureConnection({
      userId,
      roomId,
      userName,
      entityId: '' as UUID,
      source,
    });
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
      type: 'Unknown' as ChannelType,
      channelId: roomId,
      serverId: DEFAULT_SERVER_ID,
      worldId: DEFAULT_SERVER_ID,
      metadata: {},
    });
  }

  /**
   * Compose the state of the agent into an object that can be passed or used for response generation.
   * @param message The message to compose the state from.
   * @returns The state of the agent.
   */
  async composeState(message: Memory, _additionalKeys: { [key: string]: unknown } = {}) {
    return this._runtime.composeState(message as any, []);
  }

  async updateRecentMessageState(state: State): Promise<State> {
    const conversationLength = this.getConversationLength();

    // get memories
    this._runtime.getMemories({
      roomId: state.roomId,
      count: conversationLength,
      unique: false,
      tableName: state.tableName as string,
    });

    // use v1 formatMessage
    const recentMessages = formatMessages({
      actors: state.actorsData ?? [],
      messages: state.recentMessagesData?.map((memory: Memory) => {
        const newMemory = { ...memory };
        delete newMemory.embedding;
        return newMemory;
      }) as Memory[],
    });

    let allAttachments: any[] = [];

    if (state.recentMessagesData && Array.isArray(state.recentMessagesData)) {
      const lastMessageWithAttachment = state.recentMessagesData.find(
        (msg) => msg.content.attachments && msg.content.attachments.length > 0
      );

      if (lastMessageWithAttachment) {
        const lastMessageTime = lastMessageWithAttachment?.createdAt ?? Date.now();
        const oneHourBeforeLastMessage = lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

        allAttachments = state.recentMessagesData
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
      recentMessagesData: state.recentMessagesData,
      attachments: formattedAttachments,
    } as State;
  }
}
