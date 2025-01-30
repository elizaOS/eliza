import type { Readable } from "stream";

/**
 * Represents a UUID string in the format "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Represents the content of a message or communication
 */
export interface Content {
    /** The main text content */
    text: string;

    /** Optional action associated with the message */
    action?: string;

    /** Optional source/origin of the content */
    source?: string;

    /** URL of the original message/post (e.g. tweet URL, Discord message link) */
    url?: string;

    /** UUID of parent message if this is a reply/thread */
    inReplyTo?: UUID;

    /** Array of media attachments */
    attachments?: Media[];

    /** Additional dynamic properties */
    [key: string]: unknown;
}

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample {
    /** User associated with the example */
    user: string;

    /** Content of the example */
    content: Content;
}

/**
 * Example conversation content with user ID
 */
export interface ConversationExample {
    /** UUID of user in conversation */
    userId: UUID;

    /** Content of the conversation */
    content: Content;
}

/**
 * Represents an actor/participant in a conversation
 */
export interface Actor {
    /** Display name */
    name: string;

    /** Username/handle */
    username: string;

    /** Additional profile details */
    details: {
        /** Short profile tagline */
        tagline: string;

        /** Longer profile summary */
        summary: string;

        /** Favorite quote */
        quote: string;
    };

    /** Unique identifier */
    id: UUID;
}

/**
 * Represents a single objective within a goal
 */
export interface Objective {
    /** Optional unique identifier */
    id?: string;

    /** Description of what needs to be achieved */
    description: string;

    /** Whether objective is completed */
    completed: boolean;
}

/**
 * Status enum for goals
 */
export enum GoalStatus {
    DONE = "DONE",
    FAILED = "FAILED",
    IN_PROGRESS = "IN_PROGRESS",
}

/**
 * Represents a high-level goal composed of objectives
 */
export interface Goal {
    /** Optional unique identifier */
    id?: UUID;

    /** Room ID where goal exists */
    roomId: UUID;

    /** User ID of goal owner */
    userId: UUID;

    /** Name/title of the goal */
    name: string;

    /** Current status */
    status: GoalStatus;

    /** Component objectives */
    objectives: Objective[];
}

/**
 * Model size/type classification
 */
export enum ModelClass {
    SMALL = "small",
    MEDIUM = "medium",
    LARGE = "large",
    EMBEDDING = "embedding",
    IMAGE = "image",
}

/**
 * Model settings
 */
export type ModelSettings = {
    /** Model name */
    name: string;

    /** Maximum input tokens */
    maxInputTokens: number;

    /** Maximum output tokens */
    maxOutputTokens: number;

    /** Optional frequency penalty */
    frequency_penalty?: number;

    /** Optional presence penalty */
    presence_penalty?: number;

    /** Optional repetition penalty */
    repetition_penalty?: number;

    /** Stop sequences */
    stop: string[];

    /** Temperature setting */
    temperature: number;

    /** Optional telemetry configuration (experimental) */
    experimental_telemetry?: TelemetrySettings;
};

/** Image model settings */
export type ImageModelSettings = {
    name: string;
    steps?: number;
};

/** Embedding model settings */
export type EmbeddingModelSettings = {
    name: string;
    dimensions?: number;
};

/**
 * Configuration for an AI model
 */
export type Model = {
    /** Optional API endpoint */
    endpoint?: string;

    /** Model names by size class */
    model: {
        [ModelClass.SMALL]?: ModelSettings;
        [ModelClass.MEDIUM]?: ModelSettings;
        [ModelClass.LARGE]?: ModelSettings;
        [ModelClass.EMBEDDING]?: EmbeddingModelSettings;
        [ModelClass.IMAGE]?: ImageModelSettings;
    };
};

/**
 * Model configurations by provider
 */
export type Models = {
    [ModelProviderName.OPENAI]: Model;
    [ModelProviderName.ETERNALAI]: Model;
    [ModelProviderName.ANTHROPIC]: Model;
    [ModelProviderName.GROK]: Model;
    [ModelProviderName.GROQ]: Model;
    [ModelProviderName.LLAMACLOUD]: Model;
    [ModelProviderName.TOGETHER]: Model;
    [ModelProviderName.LLAMALOCAL]: Model;
    [ModelProviderName.LMSTUDIO]: Model;
    [ModelProviderName.GOOGLE]: Model;
    [ModelProviderName.MISTRAL]: Model;
    [ModelProviderName.CLAUDE_VERTEX]: Model;
    [ModelProviderName.REDPILL]: Model;
    [ModelProviderName.OPENROUTER]: Model;
    [ModelProviderName.OLLAMA]: Model;
    [ModelProviderName.HEURIST]: Model;
    [ModelProviderName.GALADRIEL]: Model;
    [ModelProviderName.FAL]: Model;
    [ModelProviderName.GAIANET]: Model;
    [ModelProviderName.ALI_BAILIAN]: Model;
    [ModelProviderName.VOLENGINE]: Model;
    [ModelProviderName.NANOGPT]: Model;
    [ModelProviderName.HYPERBOLIC]: Model;
    [ModelProviderName.VENICE]: Model;
    [ModelProviderName.NVIDIA]: Model;
    [ModelProviderName.NINETEEN_AI]: Model;
    [ModelProviderName.AKASH_CHAT_API]: Model;
    [ModelProviderName.LIVEPEER]: Model;
    [ModelProviderName.DEEPSEEK]: Model;
    [ModelProviderName.INFERA]: Model;
    [ModelProviderName.BEDROCK]: Model;
    [ModelProviderName.ATOMA]: Model;
};

/**
 * Available model providers
 */
export enum ModelProviderName {
    OPENAI = "openai",
    ETERNALAI = "eternalai",
    ANTHROPIC = "anthropic",
    GROK = "grok",
    GROQ = "groq",
    LLAMACLOUD = "llama_cloud",
    TOGETHER = "together",
    LLAMALOCAL = "llama_local",
    LMSTUDIO = "lmstudio",
    GOOGLE = "google",
    MISTRAL = "mistral",
    CLAUDE_VERTEX = "claude_vertex",
    REDPILL = "redpill",
    OPENROUTER = "openrouter",
    OLLAMA = "ollama",
    HEURIST = "heurist",
    GALADRIEL = "galadriel",
    FAL = "falai",
    GAIANET = "gaianet",
    ALI_BAILIAN = "ali_bailian",
    VOLENGINE = "volengine",
    NANOGPT = "nanogpt",
    HYPERBOLIC = "hyperbolic",
    VENICE = "venice",
    NVIDIA = "nvidia",
    NINETEEN_AI = "nineteen_ai",
    AKASH_CHAT_API = "akash_chat_api",
    LIVEPEER = "livepeer",
    LETZAI = "letzai",
    DEEPSEEK = "deepseek",
    INFERA = "infera",
    BEDROCK = "bedrock",
    ATOMA = "atoma",
}

/**
 * Represents the current state/context of a conversation
 */
export interface State {
    /** ID of user who sent current message */
    userId?: UUID;

    /** ID of agent in conversation */
    agentId?: UUID;

    /** Agent's biography */
    bio: string;

    /** Agent's background lore */
    lore: string;

    /** Message handling directions */
    messageDirections: string;

    /** Post handling directions */
    postDirections: string;

    /** Current room/conversation ID */
    roomId: UUID;

    /** Optional agent name */
    agentName?: string;

    /** Optional message sender name */
    senderName?: string;

    /** String representation of conversation actors */
    actors: string;

    /** Optional array of actor objects */
    actorsData?: Actor[];

    /** Optional string representation of goals */
    goals?: string;

    /** Optional array of goal objects */
    goalsData?: Goal[];

    /** Recent message history as string */
    recentMessages: string;

    /** Recent message objects */
    recentMessagesData: Memory[];

    /** Optional valid action names */
    actionNames?: string;

    /** Optional action descriptions */
    actions?: string;

    /** Optional action objects */
    actionsData?: Action[];

    /** Optional action examples */
    actionExamples?: string;

    /** Optional provider descriptions */
    providers?: string;

    /** Optional response content */
    responseData?: Content;

    /** Optional recent interaction objects */
    recentInteractionsData?: Memory[];

    /** Optional recent interactions string */
    recentInteractions?: string;

    /** Optional formatted conversation */
    formattedConversation?: string;

    /** Optional formatted knowledge */
    knowledge?: string;
    /** Optional knowledge data */
    knowledgeData?: KnowledgeItem[];
    /** Optional knowledge data */
    ragKnowledgeData?: RAGKnowledgeItem[];

    /** Additional dynamic properties */
    [key: string]: unknown;
}

/**
 * Represents a stored memory/message
 */
export interface Memory {
    /** Optional unique identifier */
    id?: UUID;

    /** Associated user ID */
    userId: UUID;

    /** Associated agent ID */
    agentId: UUID;

    /** Optional creation timestamp */
    createdAt?: number;

    /** Memory content */
    content: Content;

    /** Optional embedding vector */
    embedding?: number[];

    /** Associated room ID */
    roomId: UUID;

    /** Whether memory is unique */
    unique?: boolean;

    /** Embedding similarity score */
    similarity?: number;
}

/**
 * Example message for demonstration
 */
export interface MessageExample {
    /** Associated user */
    user: string;

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
) => Promise<unknown>;

/**
 * Callback function type for handlers
 */
export type HandlerCallback = (
    response: Content,
    files?: any,
) => Promise<Memory[]>;

/**
 * Validator function type for actions/evaluators
 */
export type Validator = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
) => Promise<boolean>;

/**
 * Represents an action the agent can perform
 */
export interface Action {
    /** Similar action descriptions */
    similes: string[];

    /** Detailed description */
    description: string;

    /** Example usages */
    examples: ActionExample[][];

    /** Handler function */
    handler: Handler;

    /** Action name */
    name: string;

    /** Validation function */
    validate: Validator;

    /** Whether to suppress the initial message when this action is used */
    suppressInitialMessage?: boolean;
}

/**
 * Example for evaluating agent behavior
 */
export interface EvaluationExample {
    /** Evaluation context */
    context: string;

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
    similes: string[];

    /** Example evaluations */
    examples: EvaluationExample[];

    /** Handler function */
    handler: Handler;

    /** Evaluator name */
    name: string;

    /** Validation function */
    validate: Validator;
}

/**
 * Provider for external data/services
 */
export interface Provider {
    /** Data retrieval function */
    get: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ) => Promise<any>;
}

/**
 * Represents a relationship between users
 */
export interface Relationship {
    /** Unique identifier */
    id: UUID;

    /** First user ID */
    userA: UUID;

    /** Second user ID */
    userB: UUID;

    /** Primary user ID */
    userId: UUID;

    /** Associated room ID */
    roomId: UUID;

    /** Relationship status */
    status: string;

    /** Optional creation timestamp */
    createdAt?: string;
}

/**
 * Represents a user account
 */
export interface Account {
    /** Unique identifier */
    id: UUID;

    /** Display name */
    name: string;

    /** Username */
    username: string;

    /** Optional additional details */
    details?: { [key: string]: any };

    /** Optional email */
    email?: string;

    /** Optional avatar URL */
    avatarUrl?: string;
}

/**
 * Room participant with account details
 */
export interface Participant {
    /** Unique identifier */
    id: UUID;

    /** Associated account */
    account: Account;
}

/**
 * Represents a conversation room
 */
export interface Room {
    /** Unique identifier */
    id: UUID;

    /** Room participants */
    participants: Participant[];
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

/**
 * Client interface for platform connections
 */
export type Client = {
    /** Start client connection */
    start: (runtime: IAgentRuntime) => Promise<unknown>;

    /** Stop client connection */
    stop: (runtime: IAgentRuntime) => Promise<unknown>;
};

/**
 * Plugin for extending agent functionality
 */
export type Plugin = {
    /** Plugin name */
    name: string;

    /** Plugin description */
    description: string;

    /** Optional actions */
    actions?: Action[];

    /** Optional providers */
    providers?: Provider[];

    /** Optional evaluators */
    evaluators?: Evaluator[];

    /** Optional services */
    services?: Service[];

    /** Optional clients */
    clients?: Client[];
};

/**
 * Available client platforms
 */
export enum Clients {
    ALEXA= "alexa",
    DISCORD = "discord",
    DIRECT = "direct",
    TWITTER = "twitter",
    TELEGRAM = "telegram",
    TELEGRAM_ACCOUNT = "telegram-account",
    FARCASTER = "farcaster",
    LENS = "lens",
    AUTO = "auto",
    SLACK = "slack",
    GITHUB = "github",
    INSTAGRAM = "instagram",
    SIMSAI = "simsai",
    XMTP = "xmtp",
    DEVA = "deva",
}

export interface IAgentConfig {
    [key: string]: string;
}

export type TelemetrySettings = {
    /**
     * Enable or disable telemetry. Disabled by default while experimental.
     */
    isEnabled?: boolean;
    /**
     * Enable or disable input recording. Enabled by default.
     *
     * You might want to disable input recording to avoid recording sensitive
     * information, to reduce data transfers, or to increase performance.
     */
    recordInputs?: boolean;
    /**
     * Enable or disable output recording. Enabled by default.
     *
     * You might want to disable output recording to avoid recording sensitive
     * information, to reduce data transfers, or to increase performance.
     */
    recordOutputs?: boolean;
    /**
     * Identifier for this function. Used to group telemetry data by function.
     */
    functionId?: string;
};

export interface ModelConfiguration {
    temperature?: number;
    max_response_length?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    maxInputTokens?: number;
    experimental_telemetry?: TelemetrySettings;
}

export type TemplateType = string | ((options: { state: State }) => string);

/**
 * Configuration for an agent character
 */
export type Character = {
    /** Optional unique identifier */
    id?: UUID;

    /** Character name */
    name: string;

    /** Optional username */
    username?: string;

    /** Optional email */
    email?: string;

    /** Optional system prompt */
    system?: string;

    /** Model provider to use */
    modelProvider: ModelProviderName;

    /** Image model provider to use, if different from modelProvider */
    imageModelProvider?: ModelProviderName;

    /** Image Vision model provider to use, if different from modelProvider */
    imageVisionModelProvider?: ModelProviderName;

    /** Optional model endpoint override */
    modelEndpointOverride?: string;

    /** Optional prompt templates */
    templates?: {
        goalsTemplate?: TemplateType;
        factsTemplate?: TemplateType;
        messageHandlerTemplate?: TemplateType;
        shouldRespondTemplate?: TemplateType;
        continueMessageHandlerTemplate?: TemplateType;
        evaluationTemplate?: TemplateType;
        twitterSearchTemplate?: TemplateType;
        twitterActionTemplate?: TemplateType;
        twitterPostTemplate?: TemplateType;
        twitterMessageHandlerTemplate?: TemplateType;
        twitterShouldRespondTemplate?: TemplateType;
        twitterVoiceHandlerTemplate?: TemplateType;
        instagramPostTemplate?: TemplateType;
        instagramMessageHandlerTemplate?: TemplateType;
        instagramShouldRespondTemplate?: TemplateType;
        farcasterPostTemplate?: TemplateType;
        lensPostTemplate?: TemplateType;
        farcasterMessageHandlerTemplate?: TemplateType;
        lensMessageHandlerTemplate?: TemplateType;
        farcasterShouldRespondTemplate?: TemplateType;
        lensShouldRespondTemplate?: TemplateType;
        telegramMessageHandlerTemplate?: TemplateType;
        telegramShouldRespondTemplate?: TemplateType;
        telegramAutoPostTemplate?: string;
        telegramPinnedMessageTemplate?: string;
        discordAutoPostTemplate?: string;
        discordAnnouncementHypeTemplate?: string;
        discordVoiceHandlerTemplate?: TemplateType;
        discordShouldRespondTemplate?: TemplateType;
        discordMessageHandlerTemplate?: TemplateType;
        slackMessageHandlerTemplate?: TemplateType;
        slackShouldRespondTemplate?: TemplateType;
        jeeterPostTemplate?: string;
        jeeterSearchTemplate?: string;
        jeeterInteractionTemplate?: string;
        jeeterMessageHandlerTemplate?: string;
        jeeterShouldRespondTemplate?: string;
        devaPostTemplate?: string;
    };

    /** Character biography */
    bio: string | string[];

    /** Character background lore */
    lore: string[];

    /** Example messages */
    messageExamples: MessageExample[][];

    /** Example posts */
    postExamples: string[];

    /** Known topics */
    topics: string[];

    /** Character traits */
    adjectives: string[];

    /** Optional knowledge base */
    knowledge?: (string | { path: string; shared?: boolean })[];

    /** Supported client platforms */
    clients: Clients[];

    /** Available plugins */
    plugins: Plugin[];

    /** Optional configuration */
    settings?: {
        secrets?: { [key: string]: string };
        intiface?: boolean;
        imageSettings?: {
            steps?: number;
            width?: number;
            height?: number;
            cfgScale?: number;
            negativePrompt?: string;
            numIterations?: number;
            guidanceScale?: number;
            seed?: number;
            modelId?: string;
            jobId?: string;
            count?: number;
            stylePreset?: string;
            hideWatermark?: boolean;
            safeMode?: boolean;
        };
        voice?: {
            model?: string; // For VITS
            url?: string; // Legacy VITS support
            elevenlabs?: {
                // New structured ElevenLabs config
                voiceId: string;
                model?: string;
                stability?: string;
                similarityBoost?: string;
                style?: string;
                useSpeakerBoost?: string;
            };
        };
        model?: string;
        modelConfig?: ModelConfiguration;
        embeddingModel?: string;
        chains?: {
            evm?: any[];
            solana?: any[];
            [key: string]: any[];
        };
        transcription?: TranscriptionProvider;
        ragKnowledge?: boolean;
    };

    /** Optional client-specific config */
    clientConfig?: {
        discord?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
            shouldRespondOnlyToMentions?: boolean;
            messageSimilarityThreshold?: number;
            isPartOfTeam?: boolean;
            teamAgentIds?: string[];
            teamLeaderId?: string;
            teamMemberInterestKeywords?: string[];
            allowedChannelIds?: string[];
            autoPost?: {
                enabled?: boolean;
                monitorTime?: number;
                inactivityThreshold?: number;
                mainChannelId?: string;
                announcementChannelIds?: string[];
                minTimeBetweenPosts?: number;
            };
        };
        telegram?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
            shouldRespondOnlyToMentions?: boolean;
            shouldOnlyJoinInAllowedGroups?: boolean;
            allowedGroupIds?: string[];
            messageSimilarityThreshold?: number;
            isPartOfTeam?: boolean;
            teamAgentIds?: string[];
            teamLeaderId?: string;
            teamMemberInterestKeywords?: string[];
            autoPost?: {
                enabled?: boolean;
                monitorTime?: number;
                inactivityThreshold?: number;
                mainChannelId?: string;
                pinnedMessagesGroups?: string[];
                minTimeBetweenPosts?: number;
            };
        };
        slack?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
        };
        gitbook?: {
            keywords?: {
                projectTerms?: string[];
                generalQueries?: string[];
            };
            documentTriggers?: string[];
        };
    };

    /** Writing style guides */
    style: {
        all: string[];
        chat: string[];
        post: string[];
    };

    /** Optional Twitter profile */
    twitterProfile?: {
        id: string;
        username: string;
        screenName: string;
        bio: string;
        nicknames?: string[];
    };

    /** Optional Instagram profile */
    instagramProfile?: {
        id: string;
        username: string;
        bio: string;
        nicknames?: string[];
    };

    /** Optional SimsAI profile */
    simsaiProfile?: {
        id: string;
        username: string;
        screenName: string;
        bio: string;
    };

    /** Optional NFT prompt */
    nft?: {
        prompt: string;
    };

    /**Optinal Parent characters to inherit information from */
    extends?: string[];

    twitterSpaces?: TwitterSpaceDecisionOptions;
};

export interface TwitterSpaceDecisionOptions {
    maxSpeakers?: number;
    topics?: string[];
    typicalDurationMinutes?: number;
    idleKickTimeoutMs?: number;
    minIntervalBetweenSpacesMinutes?: number;
    businessHoursOnly?: boolean;
    randomChance?: number;
    enableIdleMonitor?: boolean;
    enableSttTts?: boolean;
    enableRecording?: boolean;
    voiceId?: string;
    sttLanguage?: string;
    speakerMaxDurationMs?: number;
}

/**
 * Interface for database operations
 */
export interface IDatabaseAdapter {
    /** Database instance */
    db: any;

    /** Optional initialization */
    init(): Promise<void>;

    /** Close database connection */
    close(): Promise<void>;

    /** Get account by ID */
    getAccountById(userId: UUID): Promise<Account | null>;

    /** Create new account */
    createAccount(account: Account): Promise<boolean>;

    /** Get memories matching criteria */
    getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]>;

    getMemoryById(id: UUID): Promise<Memory | null>;

    getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]>;

    getMemoriesByRoomIds(params: {
        tableName: string;
        agentId: UUID;
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
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void>;

    getActorDetails(params: { roomId: UUID }): Promise<Actor[]>;

    searchMemories(params: {
        tableName: string;
        agentId: UUID;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]>;

    updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void>;

    searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        },
    ): Promise<Memory[]>;

    createMemory(
        memory: Memory,
        tableName: string,
        unique?: boolean,
    ): Promise<void>;

    removeMemory(memoryId: UUID, tableName: string): Promise<void>;

    removeAllMemories(roomId: UUID, tableName: string): Promise<void>;

    countMemories(
        roomId: UUID,
        unique?: boolean,
        tableName?: string,
    ): Promise<number>;

    getGoals(params: {
        agentId: UUID;
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]>;

    updateGoal(goal: Goal): Promise<void>;

    createGoal(goal: Goal): Promise<void>;

    removeGoal(goalId: UUID): Promise<void>;

    removeAllGoals(roomId: UUID): Promise<void>;

    getRoom(roomId: UUID): Promise<UUID | null>;

    createRoom(roomId?: UUID): Promise<UUID>;

    removeRoom(roomId: UUID): Promise<void>;

    getRoomsForParticipant(userId: UUID): Promise<UUID[]>;

    getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;

    addParticipant(userId: UUID, roomId: UUID): Promise<boolean>;

    removeParticipant(userId: UUID, roomId: UUID): Promise<boolean>;

    getParticipantsForAccount(userId: UUID): Promise<Participant[]>;

    getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

    getParticipantUserState(
        roomId: UUID,
        userId: UUID,
    ): Promise<"FOLLOWED" | "MUTED" | null>;

    setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null,
    ): Promise<void>;

    createRelationship(params: { userA: UUID; userB: UUID }): Promise<boolean>;

    getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null>;

    getRelationships(params: { userId: UUID }): Promise<Relationship[]>;

    getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
        conversationContext?: string;
    }): Promise<RAGKnowledgeItem[]>;

    searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]>;

    createKnowledge(knowledge: RAGKnowledgeItem): Promise<void>;
    removeKnowledge(id: UUID): Promise<void>;
    clearKnowledge(agentId: UUID, shared?: boolean): Promise<void>;
}

export interface IDatabaseCacheAdapter {
    getCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<string | undefined>;

    setCache(params: {
        agentId: UUID;
        key: string;
        value: string;
    }): Promise<boolean>;

    deleteCache(params: { agentId: UUID; key: string }): Promise<boolean>;
}

export interface IMemoryManager {
    runtime: IAgentRuntime;
    tableName: string;
    constructor: Function;

    addEmbeddingToMemory(memory: Memory): Promise<Memory>;

    getMemories(opts: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
    }): Promise<Memory[]>;

    getCachedEmbeddings(
        content: string,
    ): Promise<{ embedding: number[]; levenshtein_score: number }[]>;

    getMemoryById(id: UUID): Promise<Memory | null>;
    getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]>;
    searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
        },
    ): Promise<Memory[]>;

    createMemory(memory: Memory, unique?: boolean): Promise<void>;

    removeMemory(memoryId: UUID): Promise<void>;

    removeAllMemories(roomId: UUID): Promise<void>;

    countMemories(roomId: UUID, unique?: boolean): Promise<number>;
}

export interface IRAGKnowledgeManager {
    runtime: IAgentRuntime;
    tableName: string;

    getKnowledge(params: {
        query?: string;
        id?: UUID;
        limit?: number;
        conversationContext?: string;
        agentId?: UUID;
    }): Promise<RAGKnowledgeItem[]>;
    createKnowledge(item: RAGKnowledgeItem): Promise<void>;
    removeKnowledge(id: UUID): Promise<void>;
    searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array | number[];
        match_threshold?: number;
        match_count?: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]>;
    clearKnowledge(shared?: boolean): Promise<void>;
    processFile(file: {
        path: string;
        content: string;
        type: "pdf" | "md" | "txt";
        isShared: boolean;
    }): Promise<void>;
    cleanupDeletedKnowledgeFiles(): Promise<void>;
    generateScopedId(path: string, isShared: boolean): UUID;
}

export type CacheOptions = {
    expires?: number;
};

export enum CacheStore {
    REDIS = "redis",
    DATABASE = "database",
    FILESYSTEM = "filesystem",
}

export interface ICacheManager {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, options?: CacheOptions): Promise<void>;
    delete(key: string): Promise<void>;
}

export abstract class Service {
    private static instance: Service | null = null;

    static get serviceType(): ServiceType {
        throw new Error("Service must implement static serviceType getter");
    }

    public static getInstance<T extends Service>(): T {
        if (!Service.instance) {
            Service.instance = new (this as any)();
        }
        return Service.instance as T;
    }

    get serviceType(): ServiceType {
        return (this.constructor as typeof Service).serviceType;
    }

    // Add abstract initialize method that must be implemented by derived classes
    abstract initialize(runtime: IAgentRuntime): Promise<void>;
}

export interface IAgentRuntime {
    // Properties
    agentId: UUID;
    serverUrl: string;
    databaseAdapter: IDatabaseAdapter;
    token: string | null;
    modelProvider: ModelProviderName;
    imageModelProvider: ModelProviderName;
    imageVisionModelProvider: ModelProviderName;
    character: Character;
    providers: Provider[];
    actions: Action[];
    evaluators: Evaluator[];
    plugins: Plugin[];

    fetch?: typeof fetch | null;

    messageManager: IMemoryManager;
    descriptionManager: IMemoryManager;
    documentsManager: IMemoryManager;
    knowledgeManager: IMemoryManager;
    ragKnowledgeManager: IRAGKnowledgeManager;
    loreManager: IMemoryManager;

    cacheManager: ICacheManager;

    services: Map<ServiceType, Service>;
    // any could be EventEmitter
    // but I think the real solution is forthcoming as a base client interface
    clients: Record<string, any>;

    verifiableInferenceAdapter?: IVerifiableInferenceAdapter | null;

    initialize(): Promise<void>;

    registerMemoryManager(manager: IMemoryManager): void;

    getMemoryManager(name: string): IMemoryManager | null;

    getService<T extends Service>(service: ServiceType): T | null;

    registerService(service: Service): void;

    getSetting(key: string): string | null;

    // Methods
    getConversationLength(): number;

    processActions(
        message: Memory,
        responses: Memory[],
        state?: State,
        callback?: HandlerCallback,
    ): Promise<void>;

    evaluate(
        message: Memory,
        state?: State,
        didRespond?: boolean,
        callback?: HandlerCallback,
    ): Promise<string[] | null>;

    ensureParticipantExists(userId: UUID, roomId: UUID): Promise<void>;

    ensureUserExists(
        userId: UUID,
        userName: string | null,
        name: string | null,
        source: string | null,
    ): Promise<void>;

    registerAction(action: Action): void;

    ensureConnection(
        userId: UUID,
        roomId: UUID,
        userName?: string,
        userScreenName?: string,
        source?: string,
    ): Promise<void>;

    ensureParticipantInRoom(userId: UUID, roomId: UUID): Promise<void>;

    ensureRoomExists(roomId: UUID): Promise<void>;

    composeState(
        message: Memory,
        additionalKeys?: { [key: string]: unknown },
    ): Promise<State>;

    updateRecentMessageState(state: State): Promise<State>;
}

export interface IImageDescriptionService extends Service {
    describeImage(
        imageUrl: string,
    ): Promise<{ title: string; description: string }>;
}

export interface ITranscriptionService extends Service {
    transcribeAttachment(audioBuffer: ArrayBuffer): Promise<string | null>;
    transcribeAttachmentLocally(
        audioBuffer: ArrayBuffer,
    ): Promise<string | null>;
    transcribe(audioBuffer: ArrayBuffer): Promise<string | null>;
    transcribeLocally(audioBuffer: ArrayBuffer): Promise<string | null>;
}

export interface IVideoService extends Service {
    isVideoUrl(url: string): boolean;
    fetchVideoInfo(url: string): Promise<Media>;
    downloadVideo(videoInfo: Media): Promise<string>;
    processVideo(url: string, runtime: IAgentRuntime): Promise<Media>;
}

export interface ITextGenerationService extends Service {
    initializeModel(): Promise<void>;
    queueMessageCompletion(
        context: string,
        temperature: number,
        stop: string[],
        frequency_penalty: number,
        presence_penalty: number,
        max_tokens: number,
    ): Promise<any>;
    queueTextCompletion(
        context: string,
        temperature: number,
        stop: string[],
        frequency_penalty: number,
        presence_penalty: number,
        max_tokens: number,
    ): Promise<string>;
    getEmbeddingResponse(input: string): Promise<number[] | undefined>;
}

export interface IBrowserService extends Service {
    closeBrowser(): Promise<void>;
    getPageContent(
        url: string,
        runtime: IAgentRuntime,
    ): Promise<{ title: string; description: string; bodyContent: string }>;
}

export interface ISpeechService extends Service {
    getInstance(): ISpeechService;
    generate(runtime: IAgentRuntime, text: string): Promise<Readable>;
}

export interface IPdfService extends Service {
    getInstance(): IPdfService;
    convertPdfToText(pdfBuffer: Buffer): Promise<string>;
}

export interface IAwsS3Service extends Service {
    uploadFile(
        imagePath: string,
        subDirectory: string,
        useSignedUrl: boolean,
        expiresIn: number,
    ): Promise<{
        success: boolean;
        url?: string;
        error?: string;
    }>;
    generateSignedUrl(fileName: string, expiresIn: number): Promise<string>;
}

export interface UploadIrysResult {
    success: boolean;
    url?: string;
    error?: string;
    data?: any;
}

export interface DataIrysFetchedFromGQL {
    success: boolean;
    data: any;
    error?: string;
}

export interface GraphQLTag {
    name: string;
    values: any[];
}

export enum IrysMessageType {
    REQUEST = "REQUEST",
    DATA_STORAGE = "DATA_STORAGE",
    REQUEST_RESPONSE = "REQUEST_RESPONSE",
}

export enum IrysDataType {
    FILE = "FILE",
    IMAGE = "IMAGE",
    OTHER = "OTHER",
}

export interface IrysTimestamp {
    from: number;
    to: number;
}

export interface IIrysService extends Service {
    getDataFromAnAgent(
        agentsWalletPublicKeys: string[],
        tags: GraphQLTag[],
        timestamp: IrysTimestamp,
    ): Promise<DataIrysFetchedFromGQL>;
    workerUploadDataOnIrys(
        data: any,
        dataType: IrysDataType,
        messageType: IrysMessageType,
        serviceCategory: string[],
        protocol: string[],
        validationThreshold: number[],
        minimumProviders: number[],
        testProvider: boolean[],
        reputation: number[],
    ): Promise<UploadIrysResult>;
    providerUploadDataOnIrys(
        data: any,
        dataType: IrysDataType,
        serviceCategory: string[],
        protocol: string[],
    ): Promise<UploadIrysResult>;
}

export interface ITeeLogService extends Service {
    getInstance(): ITeeLogService;
    log(
        agentId: string,
        roomId: string,
        userId: string,
        type: string,
        content: string,
    ): Promise<boolean>;
}

export enum ServiceType {
    IMAGE_DESCRIPTION = "image_description",
    TRANSCRIPTION = "transcription",
    VIDEO = "video",
    TEXT_GENERATION = "text_generation",
    BROWSER = "browser",
    SPEECH_GENERATION = "speech_generation",
    PDF = "pdf",
    INTIFACE = "intiface",
    AWS_S3 = "aws_s3",
    BUTTPLUG = "buttplug",
    SLACK = "slack",
    VERIFIABLE_LOGGING = "verifiable_logging",
    IRYS = "irys",
    TEE_LOG = "tee_log",
    GOPLUS_SECURITY = "goplus_security",
    WEB_SEARCH = "web_search",
    EMAIL_AUTOMATION = "email_automation",
}

export enum LoggingLevel {
    DEBUG = "debug",
    VERBOSE = "verbose",
    NONE = "none",
}

export type KnowledgeItem = {
    id: UUID;
    content: Content;
};

export interface RAGKnowledgeItem {
    id: UUID;
    agentId: UUID;
    content: {
        text: string;
        metadata?: {
            isMain?: boolean;
            isChunk?: boolean;
            originalId?: UUID;
            chunkIndex?: number;
            source?: string;
            type?: string;
            isShared?: boolean;
            [key: string]: unknown;
        };
    };
    embedding?: Float32Array;
    createdAt?: number;
    similarity?: number;
    score?: number;
}

export interface ActionResponse {
    like: boolean;
    retweet: boolean;
    quote?: boolean;
    reply?: boolean;
}

export interface ISlackService extends Service {
    client: any;
}

/**
 * Available verifiable inference providers
 */
export enum VerifiableInferenceProvider {
    RECLAIM = "reclaim",
    OPACITY = "opacity",
    PRIMUS = "primus",
}

/**
 * Options for verifiable inference
 */
export interface VerifiableInferenceOptions {
    /** Custom endpoint URL */
    endpoint?: string;
    /** Custom headers */
    headers?: Record<string, string>;
    /** Provider-specific options */
    providerOptions?: Record<string, unknown>;
}

/**
 * Result of a verifiable inference request
 */
export interface VerifiableInferenceResult {
    /** Generated text */
    text: string;
    /** Proof */
    proof: any;
    /** Proof id */
    id?: string;
    /** Provider information */
    provider: VerifiableInferenceProvider;
    /** Timestamp */
    timestamp: number;
}

/**
 * Interface for verifiable inference adapters
 */
export interface IVerifiableInferenceAdapter {
    options: any;
    /**
     * Generate text with verifiable proof
     * @param context The input text/prompt
     * @param modelClass The model class/name to use
     * @param options Additional provider-specific options
     * @returns Promise containing the generated text and proof data
     */
    generateText(
        context: string,
        modelClass: string,
        options?: VerifiableInferenceOptions,
    ): Promise<VerifiableInferenceResult>;

    /**
     * Verify the proof of a generated response
     * @param result The result containing response and proof to verify
     * @returns Promise indicating if the proof is valid
     */
    verifyProof(result: VerifiableInferenceResult): Promise<boolean>;
}

export enum TokenizerType {
    Auto = "auto",
    TikToken = "tiktoken",
}

export enum TranscriptionProvider {
    OpenAI = "openai",
    Deepgram = "deepgram",
    Local = "local",
}

export enum ActionTimelineType {
    ForYou = "foryou",
    Following = "following",
}
export enum KnowledgeScope {
    SHARED = "shared",
    PRIVATE = "private",
}

export enum CacheKeyPrefix {
    KNOWLEDGE = "knowledge",
}

export interface DirectoryItem {
    directory: string;
    shared?: boolean;
}

export interface ChunkRow {
    id: string;
    // Add other properties if needed
}
