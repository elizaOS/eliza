import { join } from "node:path";
import { names, uniqueNamesGenerator } from "unique-names-generator";
import { v4 as uuidv4, v4 } from "uuid";
import {
    composeActionExamples,
    formatActionNames,
    formatActions,
} from "./actions.ts";
import { addHeader, composeContext } from "./context.ts";
import {
    evaluationTemplate,
    formatEvaluatorExamples,
    formatEvaluatorNames,
    formatEvaluators,
} from "./evaluators.ts";
import { generateText } from "./generation.ts";
import { formatGoalsAsString, getGoals } from "./goals.ts";
import { elizaLogger, handlePluginImporting, logger } from "./index.ts";
import knowledge from "./knowledge.ts";
import { MemoryManager } from "./memory.ts";
import { formatActors, formatMessages, getActorDetails } from "./messages.ts";
import { parseJsonArrayFromText } from "./parsing.ts";
import { formatPosts } from "./posts.ts";
import { getProviders } from "./providers.ts";
import settings from "./settings.ts";
import {
    type Action,
    type Actor,
    type Adapter,
    type Character,
    type ClientInstance,
    type DirectoryItem,
    type Evaluator,
    type Goal,
    type HandlerCallback,
    type IAgentRuntime,
    type ICacheManager,
    type IDatabaseAdapter,
    type IMemoryManager,
    type KnowledgeItem,
    type Memory,
    ModelClass,
    type Plugin,
    type Provider,
    type State,
    type UUID,
    type ServiceType,
    type Service,
    type Route,
    type Task,
    ChannelType,
    type RoomData,
    type WorldData
} from "./types.ts";
import { stringToUuid } from "./uuid.ts";
import { messageEvents } from "./messages.ts";

function formatKnowledge(knowledge: KnowledgeItem[]): string {
    return knowledge
        .map((knowledge) => `- ${knowledge.content.text}`)
        .join("\n");
}

/**
 * Manages knowledge-related operations for the agent runtime
 */
class KnowledgeManager {
    private knowledgeRoot: string;
    private runtime: AgentRuntime;

    constructor(runtime: AgentRuntime, knowledgeRoot: string) {
        this.runtime = runtime;
        this.knowledgeRoot = knowledgeRoot;
    }

    private async handleProcessingError(error: any, context: string) {
        logger.error(
            `Error ${context}:`,
            error?.message || error || "Unknown error"
        );
        throw error;
    }

    private async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
        const existingDocument = await this.runtime.documentsManager.getMemoryById(knowledgeId);
        return !!existingDocument;
    }

    async processCharacterKnowledge(items: string[]) {
        for (const item of items) {
            try {
                const knowledgeId = stringToUuid(item);
                if (await this.checkExistingKnowledge(knowledgeId)) {
                    continue;
                }

                logger.info(
                    "Processing knowledge for ",
                    this.runtime.character.name,
                    " - ",
                    item.slice(0, 100),
                );

                await knowledge.set(this.runtime, {
                    id: knowledgeId,
                    content: {
                        text: item,
                    },
                });
            } catch (error) {
                await this.handleProcessingError(error, "processing character knowledge");
            }
        }
    }
}

/**
 * Manages memory-related operations and memory managers
 */
class MemoryManagerService {
    private runtime: IAgentRuntime;
    private memoryManagers: Map<string, IMemoryManager>;

    constructor(runtime: IAgentRuntime, knowledgeRoot: string) {
        this.runtime = runtime;
        this.memoryManagers = new Map();

        // Initialize default memory managers
        this.initializeDefaultManagers(knowledgeRoot);
    }

    private initializeDefaultManagers(_knowledgeRoot: string) {
        // Message manager for storing messages
        this.registerMemoryManager(new MemoryManager({
            runtime: this.runtime,
            tableName: "messages",
        }));

        // Description manager for storing user descriptions
        this.registerMemoryManager(new MemoryManager({
            runtime: this.runtime,
            tableName: "descriptions",
        }));

        // Documents manager for large documents
        this.registerMemoryManager(new MemoryManager({
            runtime: this.runtime,
            tableName: "documents",
        }));

        // Knowledge manager for searchable fragments
        this.registerMemoryManager(new MemoryManager({
            runtime: this.runtime,
            tableName: "fragments",
        }));
    }

    registerMemoryManager(manager: IMemoryManager): void {
        if (!manager.tableName) {
            throw new Error("Memory manager must have a tableName");
        }

        if (this.memoryManagers.has(manager.tableName)) {
            logger.warn(
                `Memory manager ${manager.tableName} is already registered. Skipping registration.`,
            );
            return;
        }

        this.memoryManagers.set(manager.tableName, manager);
    }

    getMemoryManager(tableName: string): IMemoryManager | null {
        const manager = this.memoryManagers.get(tableName);
        if (!manager) {
            logger.error(`Memory manager ${tableName} not found`);
            return null;
        }
        return manager;
    }

    private getRequiredMemoryManager(tableName: string, managerType: string): IMemoryManager {
        const manager = this.getMemoryManager(tableName);
        if (!manager) {
            logger.error(`${managerType} manager not found`);
            throw new Error(`${managerType} manager not found`);
        }
        return manager;
    }

    getMessageManager(): IMemoryManager {
        return this.getRequiredMemoryManager("messages", "Message");
    }

    getDescriptionManager(): IMemoryManager {
        return this.getRequiredMemoryManager("descriptions", "Description");
    }

    getDocumentsManager(): IMemoryManager {
        return this.getRequiredMemoryManager("documents", "Documents");
    }

    getKnowledgeManager(): IMemoryManager {
        return this.getRequiredMemoryManager("fragments", "Knowledge");
    }

    getAllManagers(): Map<string, IMemoryManager> {
        return this.memoryManagers;
    }
}

/**
 * Represents the runtime environment for an agent, handling message processing,
 * action registration, and interaction with external services like OpenAI and Supabase.
 */
export class AgentRuntime implements IAgentRuntime {
    readonly #conversationLength = 32 as number;
    readonly agentId: UUID;
    readonly character: Character;
    public databaseAdapter!: IDatabaseAdapter;
    readonly actions: Action[] = [];
    readonly evaluators: Evaluator[] = [];
    readonly providers: Provider[] = [];
    readonly plugins: Plugin[] = [];
    events: Map<string, ((params: any) => void)[]> = new Map();
    tasks = new Map<UUID, Task>();

    readonly fetch = fetch;
    public cacheManager!: ICacheManager;
    private clients: Map<string, ClientInstance> = new Map();
    services: Map<ServiceType, Service> = new Map();

    public adapters: Adapter[];

    private readonly knowledgeRoot: string;
    private readonly memoryManagerService: MemoryManagerService;

    models = new Map<ModelClass, ((params: any) => Promise<any>)[]>();
    routes: Route[] = [];

    constructor(opts: {
        conversationLength?: number;
        agentId?: UUID;
        character?: Character;
        plugins?: Plugin[];
        fetch?: typeof fetch;
        databaseAdapter?: IDatabaseAdapter;
        cacheManager?: ICacheManager;
        adapters?: Adapter[];
        events?: { [key: string]: ((params: any) => void)[] };
    }) {
        // use the character id if it exists, otherwise use the agentId if it is passed in, otherwise use the character name
        this.agentId =
            opts.character?.id ??
            opts?.agentId ??
            stringToUuid(opts.character?.name ?? uuidv4());
        this.character = opts.character;

        logger.debug(
            `[AgentRuntime] Process working directory: ${process.cwd()}`,
        );

        // Define the root path once
        this.knowledgeRoot = join(
            process.cwd(),
            "..",
            "characters",
            "knowledge",
        );

        logger.debug(
            `[AgentRuntime] Process knowledgeRoot: ${this.knowledgeRoot}`,
        );

        this.#conversationLength =
            opts.conversationLength ?? this.#conversationLength;

        if (opts.databaseAdapter) {
            this.databaseAdapter = opts.databaseAdapter;
        }

        logger.success(`Agent ID: ${this.agentId}`);

        this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;

        if (opts.cacheManager) {
            this.cacheManager = opts.cacheManager;
        }

        this.memoryManagerService = new MemoryManagerService(this, this.knowledgeRoot);
        const plugins = opts?.plugins ?? [];

        const events = opts?.events ?? messageEvents;

        for (const [eventName, eventHandlers] of Object.entries(events)) {
            for (const eventHandler of eventHandlers) {
                this.registerEvent(eventName, eventHandler);
            }
        }

        for (const plugin of plugins) {
            elizaLogger.info(`Initializing plugin: ${plugin.name}`);
            elizaLogger.info(`Plugin actions: ${plugin.actions}`);
            for (const action of (plugin.actions ?? [])) {
                elizaLogger.info(`Registering action: ${action.name}`);
                this.registerAction(action);
            }

            for (const evaluator of (plugin.evaluators ?? [])) {
                this.registerEvaluator(evaluator);
            }

            for (const provider of (plugin.providers ?? [])) {
                this.registerContextProvider(provider);
            }

            for (const manager of (plugin.memoryManagers ?? [])) {
                this.registerMemoryManager(manager)
            }

            for(const service of plugin.services){
                this.registerService(service);
            }

            for(const route of plugin.routes){
                this.routes.push(route);
            }

            // plugin.events is an object with keys as event names and values as event handlers
            for(const [eventName, eventHandlers] of Object.entries(plugin.events)){
                for(const eventHandler of eventHandlers){
                    this.registerEvent(eventName, eventHandler);
                }
            }

            for(const client of plugin.clients){
                client.start(this).then((startedClient) => {
                    logger.debug(
                        `Initializing client: ${client.name}`
                    );
                    this.registerClient(client.name, startedClient);
                });
            }
        }

        this.plugins = plugins;

        // Initialize adapters from options or empty array if not provided
        this.adapters = opts.adapters ?? [];

        for (const plugin of plugins) {
            if (plugin.adapters) {
                for (const adapter of plugin.adapters) {
                    this.adapters.push(adapter);
                }
            }
        }
    }
    
    registerClient(clientName: string, client: ClientInstance): void {
        if (this.clients.has(clientName)) {
            logger.warn(
                `${this.character.name}(${this.agentId}) - Client ${clientName} is already registered. Skipping registration.`
            );
            return;
        }
        this.clients.set(clientName, client);
        logger.success(`${this.character.name}(${this.agentId}) - Client ${clientName} registered successfully`);
    }

    unregisterClient(clientName: string): void {
        if (!this.clients.has(clientName)) {
            logger.warn(
                `${this.character.name}(${this.agentId}) - Client ${clientName} is not registered. Skipping unregistration.`
            );
            return;
        }
        this.clients.delete(clientName);
        logger.success(`${this.character.name}(${this.agentId}) - Client ${clientName} unregistered successfully`);
    }

    getClient(clientName: string): ClientInstance | null {
        const client = this.clients.get(clientName);
        if (!client) {
            logger.error(`Client ${clientName} not found`);
            return null;
        }
        return client;
    }

    getAllClients(): Map<string, ClientInstance> {
        return this.clients;
    }

    async stop() {
        logger.debug("runtime::stop - character", this.character.name);
        // Stop all registered clients
        for (const [clientName, client] of this.clients) {
            logger.log(`runtime::stop - requesting client stop for ${clientName}`);
            await client.stop(this);
        }
    }

    async initialize() {
        // load the character plugins dymamically from string
        if(this.character.plugins){
            const plugins = await handlePluginImporting(this.character.plugins) as Plugin[];
            if (plugins?.length > 0) {
                for (const plugin of plugins) {
                    if(!plugin) {
                        continue;
                    }
                    if (plugin.clients) {
                        for (const client of plugin.clients) {
                            const startedClient = await client.start(this);
                            logger.debug(
                                `Initializing client: ${client.name}`
                            );
                            this.registerClient(client.name, startedClient);
                        }
                    }

                    if (plugin.actions) {
                        for (const action of plugin.actions) {
                            this.registerAction(action);
                        }
                    }

                    if (plugin.evaluators) {
                        for (const evaluator of plugin.evaluators) {
                            this.registerEvaluator(evaluator);
                        }
                    }

                    if (plugin.providers) {
                        for (const provider of plugin.providers) {
                            this.registerContextProvider(provider);
                        }
                    }

                    if (plugin.models) {
                        for (const [modelClass, handler] of Object.entries(plugin.models)) {
                            this.registerModel(modelClass as ModelClass, handler as (params: any) => Promise<any>);
                        }
                    }
                    if (plugin.services) {
                        for(const service of plugin.services){
                            this.services.set(service.serviceType, service);
                        }
                    }
                    if (plugin.routes) {
                        for(const route of plugin.routes){
                            this.routes.push(route);
                        }
                    }

                    if (plugin.events) {
                        for(const [eventName, eventHandlers] of Object.entries(plugin.events)){
                            for(const eventHandler of eventHandlers){
                                this.registerEvent(eventName, eventHandler);
                            }
                        }
                    }
                    
                    this.plugins.push(plugin);
                }
            }
        }

        if (this.services) {
            for(const [_, service] of this.services.entries()) {
                await service.initialize(this);
            }
        }

        await this.ensureEmbeddingDimension();
        
        await this.ensureUserExists(
            this.agentId,
            this.character.username || this.character.name,
            this.character.name,
        );
        await this.ensureRoomExists({id: this.agentId, name: this.character.name, source: "self", type: ChannelType.SELF});
        await this.ensureParticipantInRoom(this.agentId, this.agentId);
        await this.ensureCharacterExists(this.character);

        if (this.character?.knowledge && this.character.knowledge.length > 0) {
            // Non-RAG mode: only process string knowledge
            const stringKnowledge = this.character.knowledge.filter(
                (item): item is string => typeof item === "string",
            );
            await this.processCharacterKnowledge(stringKnowledge);
        }
    }

    private async processCharacterKnowledge(items: string[]) {
        const knowledgeManager = new KnowledgeManager(this, this.knowledgeRoot);
        await knowledgeManager.processCharacterKnowledge(items);
    }

    setSetting(key: string, value: string | boolean | null | any, secret = false) {
        if(secret) {
            this.character.secrets[key] = value;
        } else {
            this.character.settings[key] = value;
        }
    }

    getSetting(key: string): string | boolean | null | any {
        const value = this.character.secrets?.[key] || 
                     this.character.settings?.[key] ||
                     this.character.settings?.secrets?.[key] ||
                     settings[key];

        if (value === "true") return true;
        if (value === "false") return false;
        return value || null;
    }

    /**
     * Get the number of messages that are kept in the conversation buffer.
     * @returns The number of recent messages to be kept in memory.
     */
    getConversationLength() {
        return this.#conversationLength;
    }

    /**
     * Register a provider for the agent to use.
     * @param provider The provider to register.
     */
    registerProvider(provider: Provider) {
        this.providers.push(provider);
    }

    /**
     * Register an action for the agent to perform.
     * @param action The action to register.
     */
    registerAction(action: Action) {
        logger.success(`${this.character.name}(${this.agentId}) - Registering action: ${action.name}`);
        this.actions.push(action);
    }

    /**
     * Register an evaluator to assess and guide the agent's responses.
     * @param evaluator The evaluator to register.
     */
    registerEvaluator(evaluator: Evaluator) {
        this.evaluators.push(evaluator);
    }

    /**
     * Register a context provider to provide context for message generation.
     * @param provider The context provider to register.
     */
    registerContextProvider(provider: Provider) {
        this.providers.push(provider);
    }

    /**
     * Process the actions of a message.
     * @param message The message to process.
     * @param responses The array of response memories to process actions from.
     * @param state Optional state object for the action processing.
     * @param callback Optional callback handler for action results.
     */
    async processActions(
        message: Memory,
        responses: Memory[],
        state?: State,
        callback?: HandlerCallback,
    ): Promise<void> {
        for (const response of responses) {
            if (!response.content?.action) {
                logger.warn("No action found in the response content.");
                continue;
            }

            const normalizedAction = response.content.action
                .toLowerCase()
                .replace("_", "");

            logger.success(`Normalized action: ${normalizedAction}`);

            let action = this.actions.find(
                (a: { name: string }) =>
                    a.name
                        .toLowerCase()
                        .replace("_", "")
                        .includes(normalizedAction) ||
                    normalizedAction.includes(
                        a.name.toLowerCase().replace("_", ""),
                    ),
            );

            if (!action) {
                logger.info("Attempting to find action in similes.");
                for (const _action of this.actions) {
                    const simileAction = _action.similes.find(
                        (simile) =>
                            simile
                                .toLowerCase()
                                .replace("_", "")
                                .includes(normalizedAction) ||
                            normalizedAction.includes(
                                simile.toLowerCase().replace("_", ""),
                            ),
                    );
                    if (simileAction) {
                        action = _action;
                        logger.success(
                            `Action found in similes: ${action.name}`,
                        );
                        break;
                    }
                }
            }

            if (!action) {
                logger.error(
                    "No action found for",
                    response.content.action,
                );
                continue;
            }

            if (!action.handler) {
                logger.error(`Action ${action.name} has no handler.`);
                continue;
            }

            try {
                logger.info(
                    `Executing handler for action: ${action.name}`,
                );
                await action.handler(this, message, state, {}, callback, responses);
            } catch (error) {
                logger.error(error);
                throw error;
            }
        }
    }

    /**
     * Evaluate the message and state using the registered evaluators.
     * @param message The message to evaluate.
     * @param state The state of the agent.
     * @param didRespond Whether the agent responded to the message.~
     * @param callback The handler callback
     * @returns The results of the evaluation.
     */
    async evaluate(
        message: Memory,
        state: State,
        didRespond?: boolean,
        callback?: HandlerCallback,
    ) {
        const evaluatorPromises = this.evaluators.map(
            async (evaluator: Evaluator) => {
                logger.log("Evaluating", evaluator.name);
                if (!evaluator.handler) {
                    return null;
                }
                if (!didRespond && !evaluator.alwaysRun) {
                    return null;
                }
                const result = await evaluator.validate(this, message, state);
                if (result) {
                    return evaluator;
                }
                return null;
            },
        );

        const resolvedEvaluators = await Promise.all(evaluatorPromises);
        const evaluatorsData = resolvedEvaluators.filter(
            (evaluator): evaluator is Evaluator => evaluator !== null,
        );

        // if there are no evaluators this frame, return
        if (!evaluatorsData || evaluatorsData.length === 0) {
            return [];
        }

        const context = composeContext({
            state: {
                ...state,
                evaluators: formatEvaluators(evaluatorsData),
                evaluatorNames: formatEvaluatorNames(evaluatorsData),
            },
            template:
                this.character.templates?.evaluationTemplate ||
                evaluationTemplate,
        });

        const result = await generateText({
            runtime: this,
            context,
            modelClass: ModelClass.TEXT_SMALL,
        });

        const evaluators = parseJsonArrayFromText(
            result,
        ) as unknown as string[];

        for (const evaluator of this.evaluators) {
            if (!evaluators?.includes(evaluator.name)) continue;

            if (evaluator.handler)
                await evaluator.handler(this, message, state, {}, callback);
        }

        return evaluators;
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
    ) {
        const account = await this.databaseAdapter.getAccountById(userId);
        if (!account) {
            await this.databaseAdapter.createAccount({
                id: userId,
                name: name || this.character.name || "Unknown User",
                username: userName || this.character.username || "Unknown",
                email: email || this.character.email || userId,
            });
            logger.success(`User ${userName} created successfully.`);
        }
    }

    /**
     * Get the profile of a user.
     * @param userId - The user ID to get the profile of.
     * @returns The profile of the user.
     */
    async getUserProfile(userId: UUID) {
        const account = await this.databaseAdapter.getAccountById(userId);
        return account;
    }

    async ensureParticipantInRoom(userId: UUID, roomId: UUID) {
        const participants =
            await this.databaseAdapter.getParticipantsForRoom(roomId);
        if (!participants.includes(userId)) {
            await this.databaseAdapter.addParticipant(userId, roomId);
            if (userId === this.agentId) {
                logger.log(
                    `Agent ${this.character.name} linked to room ${roomId} successfully.`,
                );
            } else {
                logger.log(
                    `User ${userId} linked to room ${roomId} successfully.`,
                );
            }
        }
    }

    async ensureConnection({
        userId,
        roomId,
        userName,
        userScreenName,
        source,
        channelId,
        serverId,
        type,
    }: {
        userId: UUID,
        roomId: UUID,
        userName?: string,
        userScreenName?: string,
        source?: string,
        type?: ChannelType
        channelId?: string,
        serverId?: string,
    }) {
        if(userId === this.agentId) {
            throw new Error("Agent should not connect to itself");
        }

        await Promise.all([
            this.ensureUserExists(
                this.agentId,
                this.character.username ?? "Agent",
                this.character.name ?? "Agent",
                source,
            ),
            this.ensureUserExists(
                userId,
                userName ?? `User${userId}`,
                userScreenName ?? `User${userId}`,
                source,
            ),
            this.ensureRoomExists({id: roomId, source, type, channelId, serverId}),
        ]);

        await Promise.all([
            this.ensureParticipantInRoom(userId, roomId),
            this.ensureParticipantInRoom(this.agentId, roomId),
        ]);
    }

    /**
     * Get a world by ID.
     * @param worldId - The ID of the world to get.
     * @returns The world.
     */
    async getWorld(worldId: UUID) {
        return await this.databaseAdapter.getWorld(worldId);
    }

    /**
     * Ensure the existence of a world.
     */
    async ensureWorldExists({id, name, serverId}: WorldData) {
        const world = await this.databaseAdapter.getWorld(id);
        if (!world) {
            await this.databaseAdapter.createWorld({id, name, agentId: this.agentId, serverId});
            logger.log(`World ${id} created successfully.`);
        }
    }

    /**
     * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
     * and agent are added as participants. The room ID is returned.
     * @param userId - The user ID to create a room with.
     * @returns The room ID of the room between the agent and the user.
     * @throws An error if the room cannot be created.
     */
    async ensureRoomExists({id, name, source, type, channelId, serverId, worldId}: RoomData) {
        const room = await this.databaseAdapter.getRoom(id, this.agentId);
        if (!room) {
            await this.databaseAdapter.createRoom({id, name, agentId: this.agentId, source, type, channelId, serverId, worldId});
            logger.log(`Room ${id} created successfully.`);
        }
    }

    /**
     * Get the room ID of the room between the agent and a user.
     * @param userId - The user ID to get the room ID of.
     * @returns The room ID of the room between the agent and the user.
     */
    async getRoom(userId: UUID) {
        return await this.databaseAdapter.getRoom(userId, this.agentId);
    }

    /**
     * Compose the state of the agent into an object that can be passed or used for response generation.
     * @param message The message to compose the state from.
     * @returns The state of the agent.
     */
    async composeState(
        message: Memory,
        additionalKeys: { [key: string]: unknown } = {},
    ) {
        const { userId, roomId } = message;

        const conversationLength = this.getConversationLength();

        const [actorsData, recentMessagesData, goalsData]: [
            Actor[],
            Memory[],
            Goal[],
        ] = await Promise.all([
            getActorDetails({ runtime: this, roomId }),
            this.messageManager.getMemories({
                roomId,
                count: conversationLength,
                unique: false,
            }),
            getGoals({
                runtime: this,
                count: 10,
                onlyInProgress: false,
                roomId,
            }),
        ]);

        const goals = formatGoalsAsString({ goals: goalsData });

        const actors = formatActors({ actors: actorsData ?? [] });

        const recentMessages = formatMessages({
            messages: recentMessagesData,
            actors: actorsData,
        });

        const recentPosts = formatPosts({
            messages: recentMessagesData,
            actors: actorsData,
            conversationHeader: false,
        });

        const senderName = actorsData?.find(
            (actor: Actor) => actor.id === userId,
        )?.name;

        // TODO: We may wish to consolidate and just accept character.name here instead of the actor name
        const agentName =
            actorsData?.find((actor: Actor) => actor.id === this.agentId)
                ?.name || this.character.name;

        let allAttachments = message.content.attachments || [];

        if (recentMessagesData && Array.isArray(recentMessagesData)) {
            const lastMessageWithAttachment = recentMessagesData.find(
                (msg) =>
                    msg.content.attachments &&
                    msg.content.attachments.length > 0,
            );

            if (lastMessageWithAttachment) {
                const lastMessageTime =
                    lastMessageWithAttachment?.createdAt ?? Date.now();
                const oneHourBeforeLastMessage =
                    lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

                allAttachments = recentMessagesData.reverse().flatMap((msg) => {
                    const msgTime = msg.createdAt ?? Date.now();
                    const isWithinTime = msgTime >= oneHourBeforeLastMessage;
                    const attachments = msg.content.attachments || [];
                    if (!isWithinTime) {
                        for (const attachment of attachments) {
                            attachment.text = "[Hidden]";
                        }
                    }
                    return attachments;
                });
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
  `,
            )
            .join("\n");

        const formattedCharacterPostExamples = !this.character.postExamples ? "" : this.character.postExamples
            .sort(() => 0.5 - Math.random())
            .map((post) => {
                const messageString = `${post}`;
                return messageString;
            })
            .slice(0, 50)
            .join("\n");

        const formattedCharacterMessageExamples = !this.character.messageExamples ? "" : this.character.messageExamples
            .sort(() => 0.5 - Math.random())
            .slice(0, 5)
            .map((example) => {
                const exampleNames = Array.from({ length: 5 }, () =>
                    uniqueNamesGenerator({ dictionaries: [names] }),
                );

                return example
                    .map((message) => {
                        let messageString = `${message.user}: ${message.content.text}`;
                        exampleNames.forEach((name, index) => {
                            const placeholder = `{{user${index + 1}}}`;
                            messageString = messageString.replaceAll(
                                placeholder,
                                name,
                            );
                        });
                        return messageString;
                    })
                    .join("\n");
            })
            .join("\n\n");

        const getRecentInteractions = async (
            userA: UUID,
            userB: UUID,
        ): Promise<Memory[]> => {
            // Find all rooms where userA and userB are participants
            const rooms = await this.databaseAdapter.getRoomsForParticipants([
                userA,
                userB,
            ]);

            // Check the existing memories in the database
            return this.messageManager.getMemoriesByRoomIds({
                // filter out the current room id from rooms
                roomIds: rooms.filter((room) => room !== roomId),
                limit: 20,
            });
        };

        const recentInteractions =
            userId !== this.agentId
                ? await getRecentInteractions(userId, this.agentId)
                : [];

        const getRecentMessageInteractions = async (
            recentInteractionsData: Memory[],
        ): Promise<string> => {
            // Format the recent messages
            const formattedInteractions = await Promise.all(
                recentInteractionsData.map(async (message) => {
                    const isSelf = message.userId === this.agentId;
                    let sender: string;
                    if (isSelf) {
                        sender = this.character.name;
                    } else {
                        const accountId =
                            await this.databaseAdapter.getAccountById(
                                message.userId,
                            );
                        sender = accountId?.username || "unknown";
                    }
                    return `${sender}: ${message.content.text}`;
                }),
            );

            return formattedInteractions.join("\n");
        };

        const formattedMessageInteractions =
            await getRecentMessageInteractions(recentInteractions);

        const getRecentPostInteractions = async (
            recentInteractionsData: Memory[],
            actors: Actor[],
        ): Promise<string> => {
            const formattedInteractions = formatPosts({
                messages: recentInteractionsData,
                actors,
                conversationHeader: true,
            });

            return formattedInteractions;
        };

        const formattedPostInteractions = await getRecentPostInteractions(
            recentInteractions,
            actorsData,
        );

        // if bio is a string, use it. if its an array, pick one at random
        let bio = this.character.bio || "";
        if (Array.isArray(bio)) {
            // get three random bio strings and join them with " "
            bio = bio
                .sort(() => 0.5 - Math.random())
                .slice(0, 3)
                .join(" ");
        }

        let knowledgeData = [];
        let formattedKnowledge = "";

        knowledgeData = await knowledge.get(this, message);

        formattedKnowledge = formatKnowledge(knowledgeData);

        const system = this.character.system ?? "";

        const initialState = {
            agentId: this.agentId,
            agentName,
            system,
            bio,
            adjective:
                this.character.adjectives &&
                    this.character.adjectives.length > 0
                    ? this.character.adjectives[
                    Math.floor(
                        Math.random() * this.character.adjectives.length,
                    )
                    ]
                    : "",
            knowledge: formattedKnowledge,
            knowledgeData: knowledgeData,
            // Recent interactions between the sender and receiver, formatted as messages
            recentMessageInteractions: formattedMessageInteractions,
            // Recent interactions between the sender and receiver, formatted as posts
            recentPostInteractions: formattedPostInteractions,
            // Raw memory[] array of interactions
            recentInteractionsData: recentInteractions,
            // randomly pick one topic
            topic:
                this.character.topics && this.character.topics.length > 0
                    ? this.character.topics[
                    Math.floor(
                        Math.random() * this.character.topics.length,
                    )
                    ]
                    : null,
            topics:
                this.character.topics && this.character.topics.length > 0
                    ? `${this.character.name} is interested in ${this.character.topics
                        .sort(() => 0.5 - Math.random())
                        .slice(0, 5)
                        .map((topic, index, array) => {
                            if (index === array.length - 2) {
                                return `${topic} and `;
                            }
                            // if last topic, don't add a comma
                            if (index === array.length - 1) {
                                return topic;
                            }
                            return `${topic}, `;
                        })
                        .join("")}`
                    : "",
            characterPostExamples:
                formattedCharacterPostExamples &&
                    formattedCharacterPostExamples.replaceAll("\n", "").length > 0
                    ? addHeader(
                        `# Example Posts for ${this.character.name}`,
                        formattedCharacterPostExamples,
                    )
                    : "",
            characterMessageExamples:
                formattedCharacterMessageExamples &&
                    formattedCharacterMessageExamples.replaceAll("\n", "").length >
                    0
                    ? addHeader(
                        `# Example Conversations for ${this.character.name}`,
                        formattedCharacterMessageExamples,
                    )
                    : "",
            messageDirections:
                this.character?.style?.all?.length > 0 ||
                    this.character?.style?.chat.length > 0
                    ? addHeader(
                        `# Message Directions for ${this.character.name}`,
                        (() => {
                            const all = this.character?.style?.all || [];
                            const chat = this.character?.style?.chat || [];
                            return [...all, ...chat].join("\n");
                        })(),
                    )
                    : "",

            postDirections:
                this.character?.style?.all?.length > 0 ||
                    this.character?.style?.post?.length > 0
                    ? addHeader(
                        `# Post Directions for ${this.character.name}`,
                        (() => {
                            const all = this.character?.style?.all || [];
                            const post = this.character?.style?.post || [];
                            return [...all, ...post].join("\n");
                        })(),
                    )
                    : "",

            //old logic left in for reference
            //food for thought. how could we dynamically decide what parts of the character to add to the prompt other than random? rag? prompt the llm to decide?
            /*
            postDirections:
                this.character?.style?.all?.length > 0 ||
                this.character?.style?.post.length > 0
                    ? addHeader(
                            "# Post Directions for " + this.character.name,
                            (() => {
                                const all = this.character?.style?.all || [];
                                const post = this.character?.style?.post || [];
                                const shuffled = [...all, ...post].sort(
                                    () => 0.5 - Math.random()
                                );
                                return shuffled
                                    .slice(0, conversationLength / 2)
                                    .join("\n");
                            })()
                        )
                    : "",*/
            // Agent runtime stuff
            senderName,
            actors:
                actors && actors.length > 0
                    ? addHeader("# Actors", actors)
                    : "",
            actorsData,
            roomId,
            goals:
                goals && goals.length > 0
                    ? addHeader(
                        "# Goals\n{{agentName}} should prioritize accomplishing the objectives that are in progress.",
                        goals,
                    )
                    : "",
            goalsData,
            recentMessages:
                recentMessages && recentMessages.length > 0
                    ? addHeader("# Conversation Messages", recentMessages)
                    : "",
            recentPosts:
                recentPosts && recentPosts.length > 0
                    ? addHeader("# Posts in Thread", recentPosts)
                    : "",
            recentMessagesData,
            attachments:
                formattedAttachments && formattedAttachments.length > 0
                    ? addHeader("# Attachments", formattedAttachments)
                    : "",
            ...additionalKeys,
        } as State;

        const actionPromises = this.actions.map(async (action: Action) => {
            const result = await action.validate(this, message, initialState);
            if (result) {
                return action;
            }
            return null;
        });

        const evaluatorPromises = this.evaluators.map(async (evaluator) => {
            const result = await evaluator.validate(
                this,
                message,
                initialState,
            );
            if (result) {
                return evaluator;
            }
            return null;
        });

        const [resolvedEvaluators, resolvedActions, providers] =
            await Promise.all([
                Promise.all(evaluatorPromises),
                Promise.all(actionPromises),
                getProviders(this, message, initialState),
            ]);

        const evaluatorsData = resolvedEvaluators.filter(
            Boolean,
        ) as Evaluator[];
        const actionsData = resolvedActions.filter(Boolean) as Action[];

        const actionState = {
            actionNames:
                `Possible response actions: ${formatActionNames(actionsData)}`,
            actions:
                actionsData.length > 0
                    ? addHeader(
                        "# Available Actions",
                        formatActions(actionsData),
                    )
                    : "",
            actionExamples:
                actionsData.length > 0
                    ? addHeader(
                        "# Action Examples",
                        composeActionExamples(actionsData, 10),
                    )
                    : "",
            evaluatorsData,
            evaluators:
                evaluatorsData.length > 0
                    ? formatEvaluators(evaluatorsData)
                    : "",
            evaluatorNames:
                evaluatorsData.length > 0
                    ? formatEvaluatorNames(evaluatorsData)
                    : "",
            evaluatorExamples:
                evaluatorsData.length > 0
                    ? formatEvaluatorExamples(evaluatorsData)
                    : "",
            providers,
        };

        return { ...initialState, ...actionState } as State;
    }

    async updateRecentMessageState(state: State): Promise<State> {
        const conversationLength = this.getConversationLength();
        const recentMessagesData = await this.messageManager.getMemories({
            roomId: state.roomId,
            count: conversationLength,
            unique: false,
        });

        const recentMessages = formatMessages({
            actors: state.actorsData ?? [],
            messages: recentMessagesData.map((memory: Memory) => {
                const newMemory = { ...memory };
                newMemory.embedding = undefined;
                return newMemory;
            }),
        });

        let allAttachments = [];

        if (recentMessagesData && Array.isArray(recentMessagesData)) {
            const lastMessageWithAttachment = recentMessagesData.find(
                (msg) =>
                    msg.content.attachments &&
                    msg.content.attachments.length > 0,
            );

            if (lastMessageWithAttachment) {
                const lastMessageTime =
                    lastMessageWithAttachment?.createdAt ?? Date.now();
                const oneHourBeforeLastMessage =
                    lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

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
                `,
            )
            .join("\n");

        return {
            ...state,
            recentMessages: addHeader(
                "# Conversation Messages",
                recentMessages,
            ),
            recentMessagesData,
            attachments: formattedAttachments,
        } as State;
    }

    // IAgentRuntime interface implementation
    registerMemoryManager(manager: IMemoryManager): void {
        this.memoryManagerService.registerMemoryManager(manager);
    }

    getMemoryManager(tableName: string): IMemoryManager | null {
        return this.memoryManagerService.getMemoryManager(tableName);
    }

    getService<T extends Service>(service: ServiceType): T | null {
        const serviceInstance = this.services.get(service);
        if (!serviceInstance) {
            logger.error(`Service ${service} not found`);
            return null;
        }
        return serviceInstance as T;
    }

    async registerService(service: Service): Promise<void> {
        const serviceType = service.serviceType;
        logger.log(`${this.character.name}(${this.agentId}) - Registering service:`, serviceType);

        if (this.services.has(serviceType)) {
            logger.warn(
                `${this.character.name}(${this.agentId}) - Service ${serviceType} is already registered. Skipping registration.`
            );
            return;
        }

        // Add the service to the services map
        this.services.set(serviceType, service);
        logger.success(`${this.character.name}(${this.agentId}) - Service ${serviceType} registered successfully`);
    }

    // Memory manager getters
    get messageManager(): IMemoryManager {
        return this.memoryManagerService.getMessageManager();
    }

    get descriptionManager(): IMemoryManager {
        return this.memoryManagerService.getDescriptionManager();
    }

    get documentsManager(): IMemoryManager {
        return this.memoryManagerService.getDocumentsManager();
    }

    get knowledgeManager(): IMemoryManager {
        return this.memoryManagerService.getKnowledgeManager();
    }

    registerModel(modelClass: ModelClass, handler: (params: any) => Promise<any>) {
        if (!this.models.has(modelClass)) {
            this.models.set(modelClass, []);
        }
        this.models.get(modelClass)?.push(handler);
    }

    getModel(modelClass: ModelClass): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined {
        const models = this.models.get(modelClass);
        if (!models?.length) {
            return undefined;
        }
        return models[0];
    }

    async useModel(modelClass: ModelClass, params: any): Promise<any> {
        const model = this.getModel(modelClass);
        if (!model) {
            throw new Error(`No handler found for delegate type: ${modelClass}`);
        }
        return await model(this, params);
    }

    registerEvent(event: string, handler: (params: any) => void) {
        if (!this.events.has(event)) {
            this.events.set(event, []);
        }
        this.events.get(event)?.push(handler);
    }

    getEvent(event: string): ((params: any) => void)[] | undefined {
        return this.events.get(event);
    }

    emitEvent(event: string | string[], params: any) {
        // Handle both single event string and array of event strings
        const events = Array.isArray(event) ? event : [event];
        
        // Call handlers for each event
        for (const eventName of events) {
            const eventHandlers = this.events.get(eventName);
            if (eventHandlers) {
                for (const handler of eventHandlers) {
                    handler(params);
                }
            }
        }
    }

    async ensureCharacterExists(character: Character) {
        const characterExists = await this.databaseAdapter.getCharacter(character.name);
        if (!characterExists) {
            logger.log(`[AgentRuntime][${this.character.name}] Creating character`);
            return await this.databaseAdapter.createCharacter(character);
        }
        logger.log(`[AgentRuntime][${this.character.name}] Updating character`);
        // update the character with the latest character provided
        await this.databaseAdapter.updateCharacter(character.name, character);
    }

    async ensureEmbeddingDimension() {
        logger.log(`[AgentRuntime][${this.character.name}] Starting ensureEmbeddingDimension`);
        
        if (!this.databaseAdapter) {
            throw new Error(`[AgentRuntime][${this.character.name}] Database adapter not initialized before ensureEmbeddingDimension`);
        }

        try {
            const model = this.getModel(ModelClass.TEXT_EMBEDDING);
            if (!model) {
                throw new Error(`[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered`);
            }

            console.log(`[AgentRuntime][${this.character.name}] Getting embedding dimensions`);
            const embedding = await this.useModel(ModelClass.TEXT_EMBEDDING, null);
            
            if (!embedding || !embedding.length) {
                throw new Error(`[AgentRuntime][${this.character.name}] Invalid embedding received`);
            }

            console.log(`[AgentRuntime][${this.character.name}] Setting embedding dimension: ${embedding.length}`);
            await this.databaseAdapter.ensureEmbeddingDimension(embedding.length, this.agentId);
            console.log(`[AgentRuntime][${this.character.name}] Successfully set embedding dimension`);
        } catch (error) {
            console.log(`[AgentRuntime][${this.character.name}] Error in ensureEmbeddingDimension:`, error);
            throw error;
        }
    }



    registerTask(task: Task): UUID {
        // if task doesn't have an id, generate one
        if (!task.id) {
            task.id = uuidv4() as UUID;
        }
        this.tasks.set(task.id, task);
        return task.id;
    }

    getTasks({
        roomId,
        tags
    }: {roomId?: UUID, tags?: string[]}): Task[] | undefined {
        // filter tasks by roomId, type, or both
        const tasks = this.tasks;
        if (!tasks) {
            return undefined;
        }
        const values = Array.from(tasks.values());
        return values.filter(task => 
            (!roomId || task.roomId === roomId) && 
            (!tags || task.tags.some(tag => tags.includes(tag)))
        );
    }

    getTask(id: UUID): Task | undefined {
        return this.tasks.get(id);
    }

    updateTask(id: UUID, task: Task) {
        this.tasks.set(id, task);
    }

    deleteTask(id: UUID) {
        this.tasks.delete(id);
    }
}
