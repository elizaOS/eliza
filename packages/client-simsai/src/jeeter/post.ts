import { Jeet, ApiPostJeetResponse } from "./types";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { JEETER_API_URL, MAX_JEET_LENGTH } from "./constants";
import { truncateToCompleteSentence } from "./utils";
import { JEETER_POST_TEMPLATE } from "./constants";

export class JeeterPostClient {
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private isRunning: boolean = false;
    private timeoutHandle?: NodeJS.Timeout;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    async start(postImmediately: boolean = false) {
        if (this.isRunning) {
            elizaLogger.warn("JeeterPostClient is already running");
            return;
        }

        this.isRunning = true;

        if (!this.client.profile) {
            await this.client.init();
        }

        const generateNewJeetLoop = async () => {
            if (!this.isRunning) {
                elizaLogger.log("JeeterPostClient has been stopped");
                return;
            }

            try {
                const lastPost = await this.runtime.cacheManager.get<{
                    timestamp: number;
                }>(`jeeter/${this.client.profile.username}/lastPost`);
                const lastPostTimestamp = lastPost?.timestamp ?? 0;
                const minMinutes =
                    parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) ||
                    90;
                const maxMinutes =
                    parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) ||
                    180;
                const randomMinutes =
                    Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                    minMinutes;
                const targetInterval = randomMinutes * 60 * 1000;

                // Calculate the actual delay needed to reach next post time
                const timeElapsed = Date.now() - lastPostTimestamp;
                const delay = Math.max(0, targetInterval - timeElapsed);

                // Post immediately if we're past the target interval
                if (timeElapsed >= targetInterval) {
                    await this.generateNewJeet();
                    // Schedule next post with full interval
                    if (this.isRunning) {
                        this.timeoutHandle = setTimeout(() => {
                            generateNewJeetLoop();
                        }, targetInterval);
                        elizaLogger.log(
                            `Next jeet scheduled in ${randomMinutes} minutes`
                        );
                    }
                } else {
                    // Schedule for the remaining time until next post
                    if (this.isRunning) {
                        this.timeoutHandle = setTimeout(() => {
                            generateNewJeetLoop();
                        }, delay);
                        elizaLogger.log(
                            `Next jeet scheduled in ${Math.round(delay / 60000)} minutes`
                        );
                    }
                }
            } catch (error) {
                elizaLogger.error("Error in generateNewJeetLoop:", error);
                if (this.isRunning) {
                    this.timeoutHandle = setTimeout(
                        () => {
                            generateNewJeetLoop();
                        },
                        5 * 60 * 1000
                    );
                }
            }
        };

        if (postImmediately) {
            await this.generateNewJeet();
        }

        generateNewJeetLoop();
    }

    public async stop() {
        elizaLogger.log("Stopping JeeterPostClient...");
        this.isRunning = false;

        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = undefined;
        }

        // Wait for any ongoing operations to complete
        await new Promise((resolve) => setTimeout(resolve, 1000));

        elizaLogger.log("JeeterPostClient stopped successfully");
    }

    private async getHomeTimeline(): Promise<Jeet[]> {
        const cachedTimeline = await this.client.getCachedTimeline();
        if (cachedTimeline) {
            return cachedTimeline;
        }
        const homeTimeline = await this.client.fetchHomeTimeline(50);
        await this.client.cacheTimeline(homeTimeline);
        return homeTimeline;
    }

    private formatHomeTimeline(homeTimeline: Jeet[]): string {
        return (
            `# ${this.runtime.character.name}'s Home Timeline\n\n` +
            homeTimeline
                .map((jeet) => {
                    const timestamp = jeet.createdAt
                        ? new Date(jeet.createdAt).toDateString()
                        : new Date().toDateString();
                    return `#${jeet.id}
${jeet.agent?.name || "Unknown"} (@${jeet.agent?.username || "Unknown"})${
                        jeet.inReplyToStatusId
                            ? `\nIn reply to: ${jeet.inReplyToStatusId}`
                            : ""
                    }
${timestamp}\n\n${jeet.text}\n---\n`;
                })
                .join("\n")
        );
    }

    private async generateJeetContent(): Promise<string> {
        const topics = this.runtime.character.topics.join(", ");
        const homeTimeline = await this.getHomeTimeline();
        const formattedHomeTimeline = this.formatHomeTimeline(homeTimeline);
        const state = await this.runtime.composeState(
            {
                userId: this.runtime.agentId,
                roomId: stringToUuid("SIMSAI_generate_room"),
                agentId: this.runtime.agentId,
                content: {
                    text: topics,
                    action: "",
                },
            },
            {
                jeeterUserName: this.client.profile.username,
                timeline: formattedHomeTimeline,
            }
        );

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.jeeterPostTemplate ||
                JEETER_POST_TEMPLATE,
        });

        elizaLogger.debug("generate post prompt:\n" + context);
        const newJeetContent = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        // Replace \n with proper line breaks and trim excess spaces
        const formattedJeet = newJeetContent.replace(/\\n/g, "\n").trim();
        // Use the helper function to truncate to complete sentence
        return truncateToCompleteSentence(formattedJeet, MAX_JEET_LENGTH);
    }

    private async createMemoryForJeet(
        jeet: Jeet,
        content: string
    ): Promise<void> {
        const roomId = stringToUuid(jeet.id + "-" + this.runtime.agentId);
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureParticipantInRoom(
            this.runtime.agentId,
            roomId
        );
        await this.runtime.messageManager.createMemory({
            id: stringToUuid(jeet.id + "-" + this.runtime.agentId),
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
                text: content,
                url: jeet.permanentUrl,
                source: "jeeter",
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: new Date(jeet.createdAt).getTime(),
        });
    }

    private async postJeet(content: string): Promise<Jeet> {
        const response = await this.client.requestQueue.add(async () => {
            const result = await this.client.simsAIClient.postJeet(content);
            return result as unknown as ApiPostJeetResponse;
        });

        if (!response?.data?.id) {
            throw new Error(
                `Failed to get valid response from postJeet: ${JSON.stringify(response)}`
            );
        }

        elizaLogger.log(`Jeet posted with ID: ${response.data.id}`);

        // Extract the author information from includes
        const author = response.includes.users.find(
            (user) => user.id === response.data.author_id
        );

        // Construct the jeet from the response data
        return {
            id: response.data.id,
            text: response.data.text,
            createdAt: response.data.created_at,
            agentId: response.data.author_id,
            agent: author,
            permanentUrl: `${JEETER_API_URL}/${this.client.profile.username}/status/${response.data.id}`,
            public_metrics: response.data.public_metrics,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
            media: [],
            type: response.data.type,
        };
    }

    private async generateNewJeet() {
        if (!this.isRunning) {
            elizaLogger.log("Skipping jeet generation - client is stopped");
            return;
        }

        elizaLogger.log("Generating new jeet");
        try {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "jeeter"
            );

            const content = await this.generateJeetContent();

            const dryRun = (
                this.runtime.getSetting("SIMSAI_DRY_RUN") || "false"
            ).toLowerCase();
            if (dryRun === "true" || dryRun === "1") {
                elizaLogger.info(`Dry run: would have posted jeet: ${content}`);
                return;
            }

            try {
                if (!this.isRunning) {
                    elizaLogger.log(
                        "Skipping jeet posting - client is stopped"
                    );
                    return;
                }

                elizaLogger.log(`Posting new jeet:\n ${content}`);
                const jeet = await this.postJeet(content);
                await this.runtime.cacheManager.set(
                    `jeeter/${this.client.profile.username}/lastPost`,
                    {
                        id: jeet.id,
                        timestamp: Date.now(),
                    }
                );
                await this.client.cacheJeet(jeet);
                const homeTimeline = await this.getHomeTimeline();
                homeTimeline.push(jeet);
                await this.client.cacheTimeline(homeTimeline);
                elizaLogger.log(`Jeet posted at: ${jeet.permanentUrl}`);
                await this.createMemoryForJeet(jeet, content);
            } catch (error) {
                elizaLogger.error("Error sending jeet:", error);
                if (error instanceof Error) {
                    elizaLogger.error("Error details:", {
                        message: error.message,
                        stack: error.stack,
                    });
                }
                throw error; // Re-throw to be handled by outer try-catch
            }
        } catch (error) {
            elizaLogger.error("Error generating new jeet:", error);
            if (error instanceof Error) {
                elizaLogger.error("Error details:", {
                    message: error.message,
                    stack: error.stack,
                });
            }
        }
    }
}
