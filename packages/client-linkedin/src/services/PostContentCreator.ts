import {
    composeContext,
    generateText,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
} from "@elizaos/core";

export class PostContentCreator {
    constructor(public runtime: IAgentRuntime) {}

    async createPostContent(userId: string) {
        const roomId = stringToUuid("linkedin_generate_room-" + userId);
        const topics = this.runtime.character.topics.join(", ");

        const state = await this.runtime.composeState({
            userId: this.runtime.agentId,
            roomId: roomId,
            agentId: this.runtime.agentId,
            content: {
                text: topics || "",
                action: "LINKEDIN_POST",
            },
        });

        const context = composeContext({
            state,
            template: "post template",
        });

        return await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
    }
}
