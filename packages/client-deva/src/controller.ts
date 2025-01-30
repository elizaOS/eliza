import {
    composeContext,
    Content,
    elizaLogger,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    parseBooleanFromText,
    State,
    stringToUuid,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { DevaPersona, DevaPost } from "./types";
import { DEVA_POST_TEMPLATE } from "./templates.ts";

export class DevaController {
    private readonly runtime: IAgentRuntime;
    private readonly client: ClientBase;

    private persona: DevaPersona;
    private posts: DevaPost[];

    constructor(runtime: IAgentRuntime, client: ClientBase) {
        this.runtime = runtime;
        this.client = client;
    }

    public async init() {
        await this.populatePersona();
        await this.populatePosts();
        await this.startPosting();
    }

    private async populatePersona() {
        this.persona = await this.client.getMe();

        if (!this.persona || !this.persona.id) {
            elizaLogger.error("❌ Deva Client failed to fetch Persona");
            throw new Error("❌ Deva Client failed to fetch Persona");
        }

        elizaLogger.log(
            `✨ Deva Client successfully fetched Persona: ${this.persona.username} ID: ${this.persona.id}`
        );
    }

    private async populatePosts() {
        this.posts = await this.client.getPersonaPosts(this.persona.id);

        // Get the existing memories from the database
        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: this.posts.map((post) =>
                    stringToUuid(
                        post.in_reply_to_id + "-" + this.runtime.agentId
                    )
                ),
            });

        // Create a Set to store the IDs of existing memories
        const existingMemoryIds = new Set(
            existingMemories.map((memory) => memory.id.toString())
        );

        // Check if any of the posts don't exist in the existing memories
        const notExistingPostsInMemory = this.posts.filter(
            (post) =>
                !existingMemoryIds.has(
                    stringToUuid(post.id + "-" + this.runtime.agentId)
                )
        );

        for (const post of notExistingPostsInMemory) {
            elizaLogger.log("Saving Post", post.id);

            const roomId = stringToUuid(
                post.in_reply_to_id + "-" + this.runtime.agentId
            );

            const userId =
                post.persona_id === this.persona.id
                    ? this.runtime.agentId
                    : stringToUuid(post.persona_id);

            if (post.persona_id === this.persona.id) {
                await this.runtime.ensureConnection(
                    this.runtime.agentId,
                    roomId,
                    this.persona.username,
                    this.persona.display_name,
                    "deva"
                );
            } else {
                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    post.persona.username,
                    post.persona.display_name,
                    "deva"
                );
            }

            const content = {
                text: post.text,
                inReplyTo: stringToUuid(
                    post.in_reply_to_id + "-" + this.runtime.agentId
                ),
                source: "deva",
            } as Content;

            elizaLogger.log("Creating memory for post", post.id);

            // check if it already exists
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(post.id + "-" + this.runtime.agentId)
            );

            if (memory) {
                elizaLogger.log(
                    "Memory already exists, skipping timeline population"
                );
                continue;
            }

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(post.id + "-" + this.runtime.agentId),
                userId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: new Date(post.created_at).getTime(),
            });

            elizaLogger.log("Created memory for post", post.id);
        }

        elizaLogger.log(
            `✨ Deva Client successfully fetched Persona Posts: ${this.posts.length}`
        );
    }

    private async startPosting() {
        const shouldPostImmediately =
            this.runtime.getSetting("POST_IMMEDIATELY") != null &&
            this.runtime.getSetting("POST_IMMEDIATELY") != "" &&
            parseBooleanFromText(this.runtime.getSetting("POST_IMMEDIATELY"));

        if (shouldPostImmediately) {
            this.generateNewPost();
        }

        return this.setupPostAwaiter();
    }

    private async setupPostAwaiter() {
        // since new updates can happen meanwhile, we should check new posts
        await this.populatePosts();
        const lastPost: DevaPost | null =
            this.posts.length > 0 ? this.posts[this.posts.length - 1] : null;

        const lastPostTimestamp = lastPost
            ? new Date(lastPost.updated_at).getTime()
            : 0;

        const minMinutes =
            parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
        const maxMinutes =
            parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
        const randomMinutes =
            Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
            minMinutes;
        const delay = randomMinutes * 60 * 1000;

        if (Date.now() > lastPostTimestamp + delay) {
            await this.generateNewPost();
        }

        setTimeout(() => {
            this.setupPostAwaiter();
        }, delay);

        elizaLogger.log(`Next post scheduled in ${randomMinutes} minutes`);
    }

    private async generateNewPost() {
        elizaLogger.log("Generating new Deva Post");

        const roomId = stringToUuid(
            "deva_generate_room-" + this.persona.username
        );

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.persona.username,
            this.persona.display_name,
            "deva"
        );

        const topics = this.runtime.character.topics.join(", ");
        const state = await this.runtime.composeState({
            userId: this.runtime.agentId,
            roomId: roomId,
            agentId: this.runtime.agentId,
            content: {
                text: topics,
                action: "",
            },
        });
        const customState: State = {
            ...state,
            agentName: this.persona.display_name,
            twitterUserName: this.persona.username,
            adjective: "Any adjective",
            topic: "Any topic",
        };

        const context = composeContext({
            state: customState,
            template:
                this.runtime.character.templates?.devaPostTemplate ||
                DEVA_POST_TEMPLATE,
        });

        const newPostContent = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        // Replace \n with proper line breaks and trim excess spaces
        // const formattedPost = newPostContent.replaceAll(/\\n/g, "\n").trim();

        await this.client.makePost({
            text: newPostContent,
            in_reply_to_id: null,
        });

        console.log(newPostContent);

        elizaLogger.log(`New Post published:\n ${newPostContent}`);
    }
}
