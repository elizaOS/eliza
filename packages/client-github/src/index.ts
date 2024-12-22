import { elizaLogger, Client, IAgentRuntime, Character, ModelClass, composeContext, Memory, generateMessageResponse, Content, HandlerCallback, UUID, generateObject, stringToUuid } from "@elizaos/core";
import { validateGithubConfig } from "./environment";
import { EventEmitter } from "events";
import {
    initializeRepositoryAction,
    createCommitAction,
    createMemoriesFromFilesAction,
    createPullRequestAction,
    createIssueAction,
    modifyIssueAction,
    addCommentToIssueAction,
    ideationAction,
    incorporateRepositoryState,
    getRepositoryRoomId
} from "@elizaos/plugin-github";
import { isOODAContent, OODAContent, OODASchema } from "./types";
import { oodaTemplate } from "./templates";

export class GitHubClient extends EventEmitter {
    apiToken: string;
    runtime: IAgentRuntime;
    character: Character;

    constructor(runtime: IAgentRuntime) {
        super();

        this.apiToken = runtime.getSetting("GITHUB_API_TOKEN") as string;

        this.runtime = runtime;
        this.character = runtime.character;

        this.runtime.registerAction(initializeRepositoryAction);
        this.runtime.registerAction(createCommitAction);
        this.runtime.registerAction(createMemoriesFromFilesAction);
        this.runtime.registerAction(createPullRequestAction);
        this.runtime.registerAction(createIssueAction);
        this.runtime.registerAction(modifyIssueAction);
        this.runtime.registerAction(addCommentToIssueAction);
        this.runtime.registerAction(ideationAction);

        elizaLogger.log("GitHubClient actions and providers registered.");

        // Start the OODA loop after initialization
        this.startOodaLoop();
    }

    async stop() {
        try {
            elizaLogger.log("GitHubClient stopped successfully.");
        } catch (e) {
            elizaLogger.error("GitHubClient stop error:", e);
        }
    }

    private startOodaLoop() {
        const interval = Number(this.runtime.getSetting("GITHUB_OODA_INTERVAL_MS")) || 300000; // Default to 5 minutes
        elizaLogger.log("Starting OODA loop with interval:", interval);
        setInterval(() => {
            this.processOodaCycle();
        }, interval);
    }

    private async processOodaCycle() {
        elizaLogger.log("Starting OODA cycle...");
        const owner = this.runtime.getSetting("GITHUB_OWNER") ?? '' as string;
        const repository = this.runtime.getSetting("GITHUB_REPO") ?? '' as string;
        if (owner === '' || repository === '') {
            elizaLogger.error("GITHUB_OWNER or GITHUB_REPO is not set, skipping OODA cycle.");
            throw new Error("GITHUB_OWNER or GITHUB_REPO is not set");
        }

        const roomId = getRepositoryRoomId(this.runtime);
        elizaLogger.log("Repository room ID:", roomId);

        // Observe: Gather relevant memories related to the repository
        await this.runtime.ensureRoomExists(roomId);
        elizaLogger.log("Room exists for roomId:", roomId);
        await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);
        elizaLogger.log("Agent is a participant in roomId:", roomId);

        const memories = await this.runtime.messageManager.getMemories({
            roomId: roomId,
        });
        // elizaLogger.log("Retrieved memories:", memories);
        if (memories.length === 0) {
            elizaLogger.log("No memories found, skipping OODA cycle.");
            // time to initialize repository and create memories
            const timestamp = Date.now();
            const userIdUUID = stringToUuid(`${this.runtime.agentId}-${timestamp}`);
            const originalMemory: Memory = {
                id: stringToUuid(`${roomId}-${this.runtime.agentId}-${timestamp}-original`),
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: `No memories found, starting to initialize repository and create memories.`,
                    action: "NOTHING",
                    source: "github",
                    inReplyTo: stringToUuid(`${roomId}-${this.runtime.agentId}`)
                },
                roomId,
                createdAt: timestamp,
            }
            let originalState = await this.runtime.composeState(originalMemory);
            originalState = await incorporateRepositoryState(originalState, this.runtime, originalMemory, []);
            const initializeRepositoryMemory: Memory = {
                id: stringToUuid(`${roomId}-${this.runtime.agentId}-${timestamp}-initialize-repository`),
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: `Initialize the repository ${owner}/${repository} on sif-dev branch`,
                    action: "INITIALIZE_REPOSITORY",
                    source: "github",
                    inReplyTo: stringToUuid(`${roomId}-${this.runtime.agentId}`)
                },
                roomId,
                createdAt: timestamp,
            }
            await this.runtime.messageManager.createMemory(initializeRepositoryMemory);
            elizaLogger.debug("Memory created successfully:", {
                memoryId: initializeRepositoryMemory.id,
                action: initializeRepositoryMemory.content.action,
                userId: this.runtime.agentId,
            });
            const createMemoriesFromFilesMemory = {
                id: stringToUuid(`${roomId}-${this.runtime.agentId}-${timestamp}-create-memories-from-files`),
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: `Create memories from files for the repository ${owner}/${repository} at path '/'`,
                    action: "CREATE_MEMORIES_FROM_FILES",
                    source: "github",
                    inReplyTo: stringToUuid(`${roomId}-${this.runtime.agentId}`)
                },
                roomId,
                createdAt: timestamp,
            }
            await this.runtime.messageManager.createMemory(createMemoriesFromFilesMemory);
            elizaLogger.debug("Memory created successfully:", {
                memoryId: createMemoriesFromFilesMemory.id,
                action: createMemoriesFromFilesMemory.content.action,
                userId: this.runtime.agentId,
            });
            const callback: HandlerCallback = async (
                content: Content,
                files: any[]
            ) => {
                elizaLogger.log("Callback called with content:", content);
                return [];
            };
            await this.runtime.processActions(
                originalMemory,
                [initializeRepositoryMemory, createMemoriesFromFilesMemory],
                originalState,
                callback
            );
        }

        elizaLogger.log('Before composeState')
        const originalMemory = {
            userId: this.runtime.agentId, // TODO: this should be the user id
            roomId: roomId,
            agentId: this.runtime.agentId,
            content: { text: "sample text", action: "NOTHING", source: "github" },
        } as Memory;
        let originalState = await this.runtime.composeState(originalMemory, {});
        originalState = await incorporateRepositoryState(originalState, this.runtime, originalMemory, []);
        elizaLogger.log("Original state:", originalState);
        // Orient: Analyze the memories to determine if logging improvements are needed
        const context = composeContext({
            state: originalState,
            template: oodaTemplate,
        });
        // elizaLogger.log("Composed context for OODA cycle:", context);

        const response = await generateObject({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
            schema: OODASchema,
        });
        if (!isOODAContent(response.object)) {
            elizaLogger.error("Invalid content in response:", response.object);
            throw new Error("Invalid content");
        }

        const content = response.object as OODAContent;
        elizaLogger.log("OODA content:", content);
        if (content.action === "NOTHING") {
            elizaLogger.log("Skipping OODA cycle as action is NOTHING");
            return;
        }
        // Generate IDs with timestamp to ensure uniqueness
        const timestamp = Date.now();
        const userIdUUID = stringToUuid(`${this.runtime.agentId}-${timestamp}`);
        const memoryUUID = stringToUuid(`${roomId}-${this.runtime.agentId}-${timestamp}`);
        elizaLogger.log("Generated memory UUID:", memoryUUID);

        // Create memory with retry logic
        const newMemory: Memory = {
            id: memoryUUID,
            userId: userIdUUID,
            agentId: this.runtime.agentId,
            content: {
                text: content.action,
                action: content.action,
                source: "github",
                inReplyTo: stringToUuid(`${roomId}-${this.runtime.agentId}`)
            },
            roomId,
            createdAt: timestamp,
        };
        elizaLogger.log("New memory to be created:", newMemory);

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });
        elizaLogger.log("Generated response content:", responseContent);

        try {
            await this.runtime.messageManager.createMemory(newMemory);
            elizaLogger.debug("Memory created successfully:", {
                memoryId: memoryUUID,
                action: content.action,
                userId: this.runtime.agentId,
            });
        } catch (error) {
            if (error.code === "23505") {
                // Duplicate key error
                elizaLogger.warn("Duplicate memory, skipping:", {
                    memoryId: memoryUUID,
                });
                return;
            }
            elizaLogger.error("Error creating memory:", error);
            throw error; // Re-throw other errors
        }

        const callback: HandlerCallback = async (
            content: Content,
            files: any[]
        ) => {
            elizaLogger.log("Callback called with content:", content);
            return [];
        };

        // Update the state with the new memory
        const state = await this.runtime.composeState(newMemory);
        const newState = await this.runtime.updateRecentMessageState(state);

        elizaLogger.log("Processing actions for action:", content.action);
        await this.runtime.processActions(
            newMemory,
            [newMemory],
            newState,
            callback
        );
        elizaLogger.log("OODA cycle completed.");
    }

}

export const GitHubClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        await validateGithubConfig(runtime);
        elizaLogger.log("Starting GitHub client with agent ID:", runtime.agentId);

        const client = new GitHubClient(runtime);
        return client;
    },
    stop: async (runtime: IAgentRuntime) => {
        try {
            elizaLogger.log("Stopping GitHub client");
            await runtime.clients.github.stop();
        } catch (e) {
            elizaLogger.error("GitHub client stop error:", e);
        }
    },
};

export default GitHubClientInterface;
