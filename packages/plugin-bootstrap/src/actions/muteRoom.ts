import { composeContext } from "@elizaos/core";
import { generateTrueOrFalse } from "@elizaos/core";
import { booleanFooter } from "@elizaos/core";
import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
} from "@elizaos/core";

export const shouldMuteTemplate =
    `Based on the conversation so far:

{{recentMessages}}

Should {{agentName}} mute this room and stop responding unless explicitly mentioned?

Respond with YES if:
- The user is being aggressive, rude, or inappropriate
- The user has directly asked {{agentName}} to stop responding or be quiet
- {{agentName}}'s responses are not well-received or are annoying the user(s)

Otherwise, respond with NO.
` + booleanFooter;

export const muteRoomAction: Action = {
    name: "MUTE_ROOM",
    similes: [
        "MUTE_CHAT",
        "MUTE_CONVERSATION",
        "MUTE_ROOM",
        "MUTE_THREAD",
        "MUTE_CHANNEL",
    ],
    description:
        "Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const roomId = message.roomId;
        const userState = await runtime.databaseAdapter.getParticipantUserState(
            roomId,
            runtime.agentId
        );
        return userState !== "MUTED";
    },
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        async function _shouldMute(state: State): Promise<boolean> {
            const shouldMuteContext = composeContext({
                state,
                template: shouldMuteTemplate, // Define this template separately
            });

            const response = await generateTrueOrFalse({
                runtime,
                context: shouldMuteContext,
                modelClass: ModelClass.TEXT_LARGE,
            });

            return response;
        }

        const state = await runtime.composeState(message);

        if (await _shouldMute(state)) {
            await runtime.databaseAdapter.setParticipantUserState(
                message.roomId,
                runtime.agentId,
                "MUTED"
            );
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user3}}, please mute this channel. No need to respond here for now.",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Got it",
                    action: "MUTE_ROOM",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "@{{user1}} we could really use your input on this",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user3}}, please mute this channel for the time being",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Understood",
                    action: "MUTE_ROOM",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Hey what do you think about this new design",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "",
                    action: "IGNORE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}} plz mute this room",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "np going silent",
                    action: "MUTE_ROOM",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "whos going to the webxr meetup in an hour btw",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "IGNORE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "too many messages here {{user2}}",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "my bad ill mute",
                    action: "MUTE_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "yo {{user2}} dont talk in here",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sry",
                    action: "MUTE_ROOM",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
