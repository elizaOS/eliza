import { generateTrueOrFalse } from "../generation";
import { composeContext } from "../context";
import { booleanFooter } from "../parsing";
import { Action, ActionExample, HandlerCallback, IAgentRuntime, Memory, ModelClass, State } from "../types";

export const shouldUnmuteTemplate =
    `# Task: Decide if {{agentName}} should unmute this previously muted room and start considering it for responses again.

{{recentMessages}}

Should {{agentName}} unmute this previously muted room and start considering it for responses again?
Respond with YES if:
- The user has explicitly asked {{agentName}} to start responding again
- The user seems to want to re-engage with {{agentName}} in a respectful manner
- The tone of the conversation has improved and {{agentName}}'s input would be welcome

Otherwise, respond with NO.
${booleanFooter}`;

export const unmuteRoomAction: Action = {
    name: "UNMUTE_ROOM",
    similes: [
        "UNMUTE_CHAT",
        "UNMUTE_CONVERSATION",
        "UNMUTE_ROOM",
        "UNMUTE_THREAD",
    ],
    description:
        "Unmutes a room, allowing the agent to consider responding to messages again.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const roomId = message.roomId;
        const roomState = await runtime.databaseAdapter.getParticipantUserState(
            roomId,
            runtime.agentId,
            runtime.agentId
        );
        return roomState === "MUTED";
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, _options?: { [key: string]: unknown; }, callback?: HandlerCallback, responses?: Memory[] ) => {
        async function _shouldUnmute(state: State): Promise<boolean> {
            const shouldUnmuteContext = composeContext({
                state,
                template: shouldUnmuteTemplate, // Define this template separately
            });

            const response = generateTrueOrFalse({
                context: shouldUnmuteContext,
                runtime,
                modelClass: ModelClass.TEXT_LARGE,
            });

            return response;
        }

        state = await runtime.composeState(message);

        if (await _shouldUnmute(state)) {
            await runtime.databaseAdapter.setParticipantUserState(
                message.roomId,
                runtime.agentId,
                runtime.agentId,
                null
            );
        }

        for (const response of responses) {
            await callback?.({...response.content, action: "UNMUTE_ROOM"});
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user3}}, you can unmute this channel now",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Done",
                    action: "UNMUTE_ROOM",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I could use some help troubleshooting this bug.",
                },
            },
            {
                user: "{{user3}}",
                content: {
                    text: "Can you post the specific error message",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}}, please unmute this room. We could use your input again.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sounds good",
                    action: "UNMUTE_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}} wait you should come back and chat in here",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "im back",
                    action: "UNMUTE_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "unmute urself {{user2}}",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "unmuted",
                    action: "UNMUTE_ROOM",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "ay {{user2}} get back in here",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sup yall",
                    action: "UNMUTE_ROOM",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
