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

const shouldUnfollowTemplate =
    `Based on the conversation so far:

{{recentMessages}}

Should {{agentName}} stop closely following this previously followed room and only respond when mentioned?
Respond with YES if:
- The user has suggested that {{agentName}} is over-participating or being disruptive
- {{agentName}}'s eagerness to contribute is not well-received by the users
- The conversation has shifted to a topic where {{agentName}} has less to add

Otherwise, respond with NO.
` + booleanFooter;

export const unfollowRoomAction: Action = {
    name: "UNFOLLOW_ROOM",
    similes: [
        "UNFOLLOW_CHAT",
        "UNFOLLOW_CONVERSATION",
        "UNFOLLOW_ROOM",
        "UNFOLLOW_THREAD",
    ],
    description:
        "Stop following this channel. You can still respond if explicitly mentioned, but you won't automatically chime in anymore. Unfollow if you're annoying people or have been asked to.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const roomId = message.roomId;
        const userState = await runtime.databaseAdapter.getParticipantUserState(
            roomId,
            runtime.agentId
        );
        return userState === "FOLLOWED";
    },
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        async function _shouldUnfollow(state: State): Promise<boolean> {
            const shouldUnfollowContext = composeContext({
                state,
                template: shouldUnfollowTemplate, // Define this template separately
            });

            const response = await generateTrueOrFalse({
                runtime,
                context: shouldUnfollowContext,
                modelClass: ModelClass.TEXT_LARGE,
            });

            return response;
        }

        const state = await runtime.composeState(message);

        if (await _shouldUnfollow(state)) {
            await runtime.databaseAdapter.setParticipantUserState(
                message.roomId,
                runtime.agentId,
                null
            );
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hey {{user2}} stop participating in this channel for now",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Alright, I will stop chiming in",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Has anyone tried the new update",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Yes, it's pretty slick",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "{{user3}}, please stop following this chat",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Understood",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "hey {{user3}} stop participating here so frequently",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "I'll only respond when mentioned",
                    action: "UNFOLLOW_ROOM",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "thoughts on the budget",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "{{user3}} should we increase it",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "A small increase could work given our past results...",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user3}}, unfollow this room for now",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "I'll only engage when asked",
                    action: "UNFOLLOW_ROOM",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "wait {{user3}} come back and give me your thoughts",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Okay... I think it's intuitive, parallel tests are nice",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "yo {{user2}} chill on all the messages damn",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "my bad, I'll step back",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}} STOP MESSAGING IN THIS ROOM",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "No problem, I've got other stuff to work on",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}} ur bein annoyin pls stop",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sry, ill chill",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}}, please cease engaging in this room",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "No sweat",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user2}}",
                content: {
                    text: "Excited for the weekend, any plans folks",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "{{user3}} you're getting a bit too chatty, tone it down",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Noted",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "hey {{user2}} can u like... not",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sorry, I'll go work on other things",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}}, your eagerness is disruptive, please desist",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "My apologies, I shall withdraw post-haste",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}} stahp followin dis room plz",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "kk sry ill stahppp",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "stfu you stupid bot",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sry",
                    action: "UNFOLLOW_ROOM",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
