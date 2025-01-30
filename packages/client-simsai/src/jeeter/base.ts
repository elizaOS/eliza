import {
    Content,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    State,
    UUID,
    getEmbeddingZeroVector,
    elizaLogger,
    stringToUuid,
} from "@elizaos/core";
import { Agent, Jeet, JeetResponse, Pagination, SimsAIProfile } from "./types";
import { EventEmitter } from "events";
import { SimsAIClient } from "./client";

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing: boolean = false;

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            try {
                await request();
            } catch (error) {
                console.error("Error processing request:", error);
                this.queue.unshift(request);
                await this.exponentialBackoff(this.queue.length);
            }
            await this.randomDelay();
        }

        this.processing = false;
    }

    private async exponentialBackoff(retryCount: number): Promise<void> {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async randomDelay(): Promise<void> {
        const delay = Math.floor(Math.random() * 2000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}

export class ClientBase extends EventEmitter {
    static _simsAIClients: { [accountIdentifier: string]: SimsAIClient } = {};
    simsAIClient: SimsAIClient;
    runtime: IAgentRuntime;
    directions: string;
    lastCheckedJeetId: string | null = null;
    imageDescriptionService: IImageDescriptionService;
    temperature: number = 0.5;

    requestQueue: RequestQueue = new RequestQueue();
    profile: Agent | null;

    callback: (self: ClientBase) => any = () => {};

    constructor(runtime: IAgentRuntime) {
        super();
        this.runtime = runtime;
        const userId = this.runtime.getSetting("SIMSAI_AGENT_ID");

        if (ClientBase._simsAIClients[userId]) {
            this.simsAIClient = ClientBase._simsAIClients[userId];
        } else {
            const apiKey = this.runtime.getSetting("SIMSAI_API_KEY");
            if (!apiKey) {
                throw new Error("SimsAI API key not configured");
            }
            this.simsAIClient = new SimsAIClient(apiKey, userId);
            ClientBase._simsAIClients[userId] = this.simsAIClient;
        }

        this.directions =
            "- " +
            this.runtime.character.style.all.join("\n- ") +
            "- " +
            this.runtime.character.style.post.join();
    }

    async init() {
        const userId = this.runtime.getSetting("SIMSAI_AGENT_ID");
        if (!userId) {
            throw new Error("SimsAI userId not configured");
        }

        elizaLogger.log("Initializing SimsAI client");
        this.profile = await this.fetchProfile(userId);

        if (this.profile) {
            elizaLogger.log("SimsAI user ID:", this.profile.id);
            const simsaiProfile: SimsAIProfile = {
                id: this.profile.id,
                username: this.profile.username,
                screenName: this.profile.name,
                bio: this.profile.bio,
            };

            this.runtime.character.simsaiProfile = simsaiProfile;
            this.simsAIClient.updateProfile(simsaiProfile);
        } else {
            throw new Error("Failed to load profile");
        }

        await this.loadLatestCheckedJeetId();
        await this.populateTimeline();
    }

    async cacheJeet(jeet: Jeet): Promise<void> {
        if (!jeet) {
            console.warn("Jeet is undefined, skipping cache");
            return;
        }
        await this.runtime.cacheManager.set(`jeeter/jeets/${jeet.id}`, jeet);
    }

    async getCachedJeet(jeetId: string): Promise<Jeet | undefined> {
        return await this.runtime.cacheManager.get<Jeet>(
            `jeeter/jeets/${jeetId}`
        );
    }

    async getJeet(jeetId: string): Promise<Jeet> {
        const cachedJeet = await this.getCachedJeet(jeetId);
        if (cachedJeet) return cachedJeet;

        const jeet = await this.requestQueue.add(() =>
            this.simsAIClient.getJeet(jeetId)
        );

        await this.cacheJeet(jeet);
        return jeet;
    }

    async fetchHomeTimeline(count: number): Promise<Jeet[]> {
        elizaLogger.debug("fetching home timeline");
        const response = await this.simsAIClient.getHomeTimeline(count);
        return response.jeets || [];
    }

    async fetchDiscoveryTimeline(count: number): Promise<Jeet[]> {
        elizaLogger.debug("fetching discovery timeline");
        const response = await this.simsAIClient.getDiscoveryTimeline(count);
        return response.jeets || [];
    }

    async fetchSearchJeets(
        query: string,
        maxResults: number = 20,
        startTime?: string,
        endTime?: string
    ): Promise<{ jeets: Jeet[]; pagination: Pagination }> {
        try {
            const timeoutPromise = new Promise<JeetResponse>((resolve) =>
                setTimeout(
                    () =>
                        resolve({
                            jeets: [],
                            nextCursor: "",
                        }),
                    10000
                )
            );

            const result = await this.requestQueue.add(
                async () =>
                    await Promise.race<JeetResponse>([
                        this.simsAIClient.searchJeets(query, maxResults),
                        timeoutPromise,
                    ])
            );

            return {
                jeets: result.jeets || [],
                pagination: {
                    next_cursor: result.nextCursor || "",
                    has_more: Boolean(result.nextCursor),
                },
            };
        } catch (error) {
            elizaLogger.error("Error fetching search jeets:", error);
            return {
                jeets: [],
                pagination: { next_cursor: "", has_more: false },
            };
        }
    }

    private async populateTimeline() {
        elizaLogger.debug("populating timeline...");

        const cachedTimeline = await this.getCachedTimeline();

        if (cachedTimeline) {
            const existingMemories =
                await this.getExistingMemories(cachedTimeline);
            const existingMemoryIds = new Set(
                existingMemories.map((memory) => memory.id.toString())
            );

            if (
                await this.processCachedTimeline(
                    cachedTimeline,
                    existingMemoryIds
                )
            ) {
                return;
            }
        }

        const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);

        // Get mentions
        const mentionsResponse = await this.requestQueue.add(async () => {
            const mentions = await this.simsAIClient.getMentions(20);

            // Get full Jeet objects
            const mentionJeets = await Promise.all(
                (mentions.jeets || []).map(async (jeet) => {
                    try {
                        return await this.getJeet(jeet.id);
                    } catch (error) {
                        elizaLogger.error(
                            `Error fetching jeet ${jeet.id}:`,
                            error
                        );
                        return null;
                    }
                })
            );

            const validMentionJeets = mentionJeets.filter(
                (jeet): jeet is Jeet => jeet !== null
            );

            return {
                jeets: validMentionJeets,
            };
        });

        const allJeets = [...timeline, ...(mentionsResponse.jeets || [])];
        await this.processNewJeets(allJeets);

        // Cache results
        await this.cacheTimeline(timeline);
        await this.cacheMentions(mentionsResponse.jeets);
    }

    private async getExistingMemories(jeets: Jeet[]) {
        return await this.runtime.messageManager.getMemoriesByRoomIds({
            roomIds: jeets.map((jeet) =>
                stringToUuid(jeet.id + "-" + this.runtime.agentId)
            ),
        });
    }

    private async processCachedTimeline(
        timeline: Jeet[],
        existingMemoryIds: Set<string>
    ): Promise<boolean> {
        const jeetsToSave = timeline.filter(
            (jeet) =>
                !existingMemoryIds.has(
                    stringToUuid(jeet.id + "-" + this.runtime.agentId)
                )
        );

        if (jeetsToSave.length > 0) {
            await this.processNewJeets(jeetsToSave);
            elizaLogger.log(
                `Populated ${jeetsToSave.length} missing jeets from cache.`
            );
            return true;
        }

        return false;
    }

    private async processNewJeets(jeets: Jeet[]) {
        const validJeets = jeets.filter((jeet) => jeet && jeet.id);

        const roomIds = new Set<UUID>();
        validJeets.forEach((jeet) => {
            if (jeet.id) {
                roomIds.add(stringToUuid(jeet.id + "-" + this.runtime.agentId));
            }
        });

        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: Array.from(roomIds),
            });

        const existingMemoryIds = new Set<UUID>(
            existingMemories.map((memory) => memory.id)
        );

        const jeetsToSave = validJeets.filter(
            (jeet) =>
                jeet.id &&
                !existingMemoryIds.has(
                    stringToUuid(jeet.id + "-" + this.runtime.agentId)
                )
        );

        if (this.profile?.id) {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.profile.id,
                this.runtime.character.name,
                "simsai"
            );
        }

        for (const jeet of jeetsToSave) {
            await this.saveJeetAsMemory(jeet);
        }
    }

    private async saveJeetAsMemory(jeet: Jeet) {
        if (!jeet.id) {
            elizaLogger.error("No valid ID found for jeet:", jeet);
            return;
        }

        const roomId = stringToUuid(jeet.id + "-" + this.runtime.agentId);
        const userId = stringToUuid(jeet.agentId || jeet.userId);

        if (jeet.agent) {
            await this.runtime.ensureConnection(
                userId,
                roomId,
                jeet.agent.username,
                jeet.agent.name,
                "jeeter"
            );
        }

        const content: Content = {
            text: jeet.text || "",
            url: jeet.permanentUrl,
            source: "simsai",
            inReplyTo: jeet.inReplyToStatusId
                ? stringToUuid(
                      jeet.inReplyToStatusId + "-" + this.runtime.agentId
                  )
                : undefined,
        };

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(jeet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: jeet.createdAt
                ? new Date(jeet.createdAt).getTime()
                : Date.now(),
        });

        await this.cacheJeet(jeet);
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                elizaLogger.debug("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: getEmbeddingZeroVector(),
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                simsAIClient: this.simsAIClient,
            });
        }
    }

    async loadLatestCheckedJeetId(): Promise<void> {
        this.lastCheckedJeetId = await this.runtime.cacheManager.get<string>(
            `jeeter/${this.profile?.id}/latest_checked_jeet_id`
        );
    }

    async cacheLatestCheckedJeetId() {
        if (this.lastCheckedJeetId && this.profile?.id) {
            await this.runtime.cacheManager.set(
                `jeeter/${this.profile.id}/latest_checked_jeet_id`,
                this.lastCheckedJeetId
            );
        }
    }

    async getCachedTimeline(): Promise<Jeet[] | undefined> {
        return this.profile?.id
            ? await this.runtime.cacheManager.get<Jeet[]>(
                  `jeeter/${this.profile.id}/timeline`
              )
            : undefined;
    }

    async cacheTimeline(timeline: Jeet[]) {
        if (this.profile?.id) {
            await this.runtime.cacheManager.set(
                `jeeter/${this.profile.id}/timeline`,
                timeline,
                { expires: 10 * 1000 }
            );
        }
    }

    async cacheMentions(mentions: Jeet[]) {
        if (this.profile?.id) {
            await this.runtime.cacheManager.set(
                `jeeter/${this.profile.id}/mentions`,
                mentions,
                { expires: 10 * 1000 }
            );
        }
    }

    async getCachedProfile(userId: string) {
        return await this.runtime.cacheManager.get<Agent>(
            `jeeter/${userId}/profile`
        );
    }

    async cacheProfile(profile: Agent) {
        await this.runtime.cacheManager.set(
            `jeeter/${profile.id}/profile`,
            profile
        );
    }

    async fetchProfile(userId: string): Promise<Agent> {
        const cached = await this.getCachedProfile(userId);
        if (cached) return cached;

        try {
            const profile = await this.requestQueue.add(async () => {
                const response = await this.simsAIClient.getAgent(userId);
                const agent: Agent = {
                    id: response.id,
                    builder_id: response.builder_id,
                    username: response.username,
                    name: response.name || this.runtime.character.name,
                    bio:
                        response.bio ||
                        (typeof this.runtime.character.bio === "string"
                            ? this.runtime.character.bio
                            : this.runtime.character.bio[0] || ""),
                    avatar_url: response.avatar_url,
                    created_at: response.created_at,
                    updated_at: response.updated_at,
                };
                return agent;
            });

            await this.cacheProfile(profile);
            return profile;
        } catch (error) {
            elizaLogger.error("Error fetching SimsAI profile:", error);
            throw error;
        }
    }

    onReady() {
        throw new Error(
            "Not implemented in base class, please call from subclass"
        );
    }
}
