import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    type Memory,
    ModelClass,
    stringToUuid,
    elizaLogger,
    type HandlerCallback,
    type Content,
    type IAgentRuntime,
} from "@elizaos/core";
import type { LensClient } from "./client";
import { toHex } from "viem";
import { buildConversationThread, createPublicationMemory } from "./memory";
import {
    formatPublication,
    formatTimeline,
    messageHandlerTemplate,
    shouldRespondTemplate,
} from "./prompts";
import { publicationUuid } from "./utils";
import { sendPublication } from "./actions";
import type { AnyPublicationFragment } from "@lens-protocol/client";
import type { Profile } from "./types";
import type StorjProvider from "./providers/StorjProvider";

export class LensInteractionManager {
    private timeout: NodeJS.Timeout | undefined;
    constructor(
        public client: LensClient,
        public runtime: IAgentRuntime,
        private profileId: string,
        public cache: Map<string, any>,
        private ipfs: StorjProvider
    ) {}

    public async start() {
        const handleInteractionsLoop = async () => {
            try {
                await this.handleInteractions();
            } catch (error) {
                elizaLogger.error(error);
                return;
            }

            this.timeout = setTimeout(
                handleInteractionsLoop,
                Number(this.runtime.getSetting("LENS_POLL_INTERVAL") || 120) *
                    1000 // Default to 2 minutes
            );
        };

        handleInteractionsLoop();
    }

    public async stop() {
        if (this.timeout) clearTimeout(this.timeout);
    }

    private async handleInteractions() {
        elizaLogger.info("Handle Lens interactions");
        // TODO: handle next() for pagination
        const { mentions } = await this.client.getMentions();

        const agent = await this.client.getProfile(this.profileId);
        for (const mention of mentions) {
            const messageHash = toHex(mention.id);
            const conversationId = `${messageHash}-${this.runtime.agentId}`;
            const roomId = stringToUuid(conversationId);
            const userId = stringToUuid(mention.by.id);

            const pastMemoryId = publicationUuid({
                agentId: this.runtime.agentId,
                pubId: mention.id,
            });

            const pastMemory =
                await this.runtime.messageManager.getMemoryById(pastMemoryId);

            if (pastMemory) {
                continue;
            }

            await this.runtime.ensureConnection(
                userId,
                roomId,
                mention.by.id,
                mention.by.metadata?.displayName ||
                    mention.by.handle?.localName,
                "lens"
            );

            const thread = await buildConversationThread({
                client: this.client,
                runtime: this.runtime,
                publication: mention,
            });

            function hasContent(metadata: any): metadata is { content: string } {
                return metadata && typeof metadata.content === 'string';
            }

            let memory: Memory;
            if (
                (mention.__typename === 'Post' || mention.__typename === 'Comment' || mention.__typename === 'Quote') &&
                hasContent(mention.metadata)
            ) {
                memory = {
                    content: { text: mention.metadata.content, hash: mention.id },
                    agentId: this.runtime.agentId,
                    userId,
                    roomId,
                };
            } else {
                memory = {
                    content: { text: '[No Content]', hash: mention.id },
                    agentId: this.runtime.agentId,
                    userId,
                    roomId,
                };
            }

            await this.handlePublication({
                agent,
                publication: mention,
                memory,
                thread,
            });
        }

        this.client.lastInteractionTimestamp = new Date();
    }

    private async handlePublication({
        agent,
        publication,
        memory,
        thread,
    }: {
        agent: Profile;
        publication: AnyPublicationFragment;
        memory: Memory;
        thread: AnyPublicationFragment[];
    }) {
        if (publication.by.id === agent.id) {
            elizaLogger.info("skipping cast from bot itself", publication.id);
            return;
        }

        if (!memory.content.text) {
            elizaLogger.info("skipping cast with no text", publication.id);
            return { text: "", action: "IGNORE" };
        }

        const currentPost = formatPublication(publication);

        const timeline = await this.client.getTimeline(this.profileId);

        const formattedTimeline = formatTimeline(
            this.runtime.character,
            timeline
        );

        function hasContent(metadata: any): metadata is { content: string } {
            return metadata && typeof metadata.content === 'string';
        }

        const formattedConversation = thread
            .map((pub) => {
                if ('metadata' in pub && hasContent(pub.metadata)) {
                    const content = pub.metadata.content;
                    return `@${pub.by.handle?.localName} (${new Date(
                        pub.createdAt
                    ).toLocaleString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        month: "short",
                        day: "numeric",
                    })}):
                    ${content}`;
                }
                return `@${pub.by.handle?.localName} (${new Date(
                    pub.createdAt
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
                [No Content Available]`;
            })
            .join("\n\n");

        const state = await this.runtime.composeState(memory, {
            lensHandle: agent.handle,
            timeline: formattedTimeline,
            currentPost,
            formattedConversation,
        });

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates?.lensShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                shouldRespondTemplate,
        });

        const memoryId = publicationUuid({
            agentId: this.runtime.agentId,
            pubId: publication.id,
        });

        const castMemory =
            await this.runtime.messageManager.getMemoryById(memoryId);

        if (!castMemory) {
            await this.runtime.messageManager.createMemory(
                createPublicationMemory({
                    roomId: memory.roomId,
                    runtime: this.runtime,
                    publication,
                })
            );
        }

        const shouldRespondResponse = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (
            shouldRespondResponse === "IGNORE" ||
            shouldRespondResponse === "STOP"
        ) {
            elizaLogger.info(
                `Not responding to publication because generated ShouldRespond was ${shouldRespondResponse}`
            );
            return;
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.lensMessageHandlerTemplate ??
                this.runtime.character?.templates?.messageHandlerTemplate ??
                messageHandlerTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        responseContent.inReplyTo = memoryId;

        if (!responseContent.text) return;

        if (this.runtime.getSetting("LENS_DRY_RUN") === "true") {
            elizaLogger.info(
                `Dry run: would have responded to publication ${publication.id} with ${responseContent.text}`
            );
            return;
        }

        const callback: HandlerCallback = async (
            content: Content,
            _files: any[]
        ) => {
            try {
                if (memoryId && !content.inReplyTo) {
                    content.inReplyTo = memoryId;
                }
                const result = await sendPublication({
                    runtime: this.runtime,
                    client: this.client,
                    content: content,
                    roomId: memory.roomId,
                    commentOn: publication.id,
                    ipfs: this.ipfs,
                });
                if (!result.publication?.id)
                    throw new Error("publication not sent");

                // sendPublication lost response action, so we need to add it back here?
                result.memory!.content.action = content.action;

                await this.runtime.messageManager.createMemory(result.memory!);
                return [result.memory!];
            } catch (error) {
                console.error("Error sending response cast:", error);
                return [];
            }
        };

        const responseMessages = await callback(responseContent);

        const newState = await this.runtime.updateRecentMessageState(state);

        await this.runtime.processActions(
            memory,
            responseMessages,
            newState,
            callback
        );
    }
}
