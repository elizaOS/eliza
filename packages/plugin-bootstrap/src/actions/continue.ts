import { composeContext, elizaLogger } from "@elizaos/core";
import { generateMessageResponse, generateTrueOrFalse } from "@elizaos/core";
import { booleanFooter, messageCompletionFooter } from "@elizaos/core";
import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";

const maxContinuesInARow = 3;

export const messageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export const shouldContinueTemplate =
    `# Task: Decide if {{agentName}} should continue, or wait for others in the conversation so speak.

{{agentName}} is brief, and doesn't want to be annoying. {{agentName}} will only continue if the message requires a continuation to finish the thought.

Based on the following conversation, should {{agentName}} continue? YES or NO

{{recentMessages}}

Should {{agentName}} continue? ` + booleanFooter;

export const continueAction: Action = {
    name: "CONTINUE",
    similes: ["ELABORATE", "KEEP_TALKING"],
    description:
        "ONLY use this action when the message necessitates a follow up. Do not use this action when the conversation is finished or the user does not wish to speak (use IGNORE instead). If the last message action was CONTINUE, and the user has not responded. Use sparingly.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const recentMessagesData = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 10,
            unique: false,
        });
        const agentMessages = recentMessagesData.filter(
            (m: { userId: any }) => m.userId === runtime.agentId
        );

        // check if the last messages were all continues=
        if (agentMessages) {
            const lastMessages = agentMessages.slice(0, maxContinuesInARow);
            if (lastMessages.length >= maxContinuesInARow) {
                const allContinues = lastMessages.every(
                    (m: { content: any }) =>
                        (m.content as Content).action === "CONTINUE"
                );
                if (allContinues) {
                    return false;
                }
            }
        }

        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        }
        state = await runtime.updateRecentMessageState(state);

        // Get the agent's recent messages
        const agentMessages = state.recentMessagesData
            .filter((m: { userId: any }) => m.userId === runtime.agentId)
            .sort((a: Memory, b: Memory) => {
                // Sort by timestamp if available, assuming newer messages have higher timestamps
                const aTime = a.createdAt || 0;
                const bTime = b.createdAt || 0;
                return bTime - aTime;
            });

        // Check for immediate double response (responding twice in a row to the same message)
        const lastAgentMessage = agentMessages[0];

        if (lastAgentMessage?.content?.inReplyTo === message.id) {
            // If our last message was already a response to this message, only allow continue if:
            // 1. The last message had a CONTINUE action
            // 2. We haven't hit the maxContinuesInARow limit
            const continueCount = agentMessages
            .filter((m: Memory) => m.content?.inReplyTo === message.id)
            .filter((m: Memory) => m.content?.action === 'CONTINUE')
            .length;

            if (continueCount >= maxContinuesInARow) {
                elizaLogger.log(`[CONTINUE] Max continues (${maxContinuesInARow}) reached for this message chain`);
                return;
            }

            if (lastAgentMessage.content?.action !== 'CONTINUE') {
                elizaLogger.log(`[CONTINUE] Last message wasn't a CONTINUE, preventing double response`);
                return;
            }
        }

        // Check if our last message or message ended with a question/exclamation and warrants a stop
        if ((lastAgentMessage && lastAgentMessage.content.text &&
            (lastAgentMessage.content.text.endsWith("?") ||
            lastAgentMessage.content.text.endsWith("!"))) || (message.content.text.endsWith("?") || message.content.text.endsWith("!"))) {
            elizaLogger.log(`[CONTINUE] Last message had question/exclamation. Not proceeding.`);
            return;
        }

        // Prevent exact duplicate messages
        const messageExists = agentMessages
            .slice(0, maxContinuesInARow + 1)
            .some((m: { content: any }) => m.content.text === message.content.text);

        if (messageExists) {
            return;
        }

        async function _shouldContinue(state: State): Promise<boolean> {
            // If none of the above conditions are met, use the generateText to decide
            const shouldRespondContext = composeContext({
                state,
                template: shouldContinueTemplate,
            });

            const response = await generateTrueOrFalse({
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
                runtime,
            });

            return response;
        }

        // Use AI to determine if we should continue
        const shouldContinue = await _shouldContinue(state);
        if (!shouldContinue) {
            elizaLogger.log("[CONTINUE] Not elaborating, returning");
            return;
        }

        // Generate and send response
        const context = composeContext({
            state,
            template:
                runtime.character.templates?.continueMessageHandlerTemplate ||
                runtime.character.templates?.messageHandlerTemplate ||
                messageHandlerTemplate,
        });
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        response.inReplyTo = message.id;

        runtime.databaseAdapter.log({
            body: { message, context, response },
            userId,
            roomId,
            type: "continue",
        });

        await callback(response);

        // Check if we need to clear the CONTINUE action
        if (response.action === "CONTINUE") {
            const continueCount = agentMessages
                .slice(0, maxContinuesInARow)
                .filter((m: Memory) => m.content?.action === 'CONTINUE')
                .length;

            if (continueCount >= maxContinuesInARow - 1) {  // -1 because we're about to add another
                response.action = null;
            }
        }

        return response;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "we're planning a solo backpacking trip soon",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "oh sick", action: "CONTINUE" },
            },
            {
                user: "{{user2}}",
                content: { text: "where are you going" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "i just got a guitar and started learning last month",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "maybe we can start a band soon haha" },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "i'm not very good yet, but i've been playing until my fingers hut",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "seriously it hurts to type" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "I've been reflecting a lot on what happiness means to me lately",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "That it’s more about moments than things",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Like the best things that have ever happened were things that happened, or moments that I had with someone",
                    action: "CONTINUE",
                },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "i found some incredible art today",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "real art or digital art" },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "real art",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "the pieces are just so insane looking, one sec, let me grab a link",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "DMed it to you" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "the new exhibit downtown is rly cool, it's all about tribalism in online spaces",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "it really blew my mind, you gotta go",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "sure i'd go" },
            },
            {
                user: "{{user1}}",
                content: { text: "k i was thinking this weekend" },
                action: "CONTINUE",
            },
            {
                user: "{{user1}}",
                content: {
                    text: "i'm free sunday, we could get a crew together",
                },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "just finished the best anime i've ever seen",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "watched 40 hours of it in 2 days",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "damn, u ok",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "surprisingly yes",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "just found out theres a sequel, gg",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "i'm thinking of adopting a pet soon",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "what kind of pet",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "i'm leaning towards a cat",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "it'd be hard to take care of a dog in the city",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "i've been experimenting with vegan recipes lately",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "no thanks",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "no seriously, its so dank",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "you gotta try some of my food when you come out",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "so i've been diving into photography as a new hobby",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "oh awesome, what do you enjoy taking photos of",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "mostly nature and urban landscapes",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "there's something peaceful about capturing the world through a lens",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "i've been getting back into indie music",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "what have you been listening to",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "a bunch of random stuff i'd never heard before",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "i'll send you a playlist",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "i used to live in the city",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "bad traffic, bad air quality, tons of homeless people, no thx",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "ok dood",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "you kids today dont know the value of hard work",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "always on your phones",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sure grandpa lets get you to bed",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "hey fren r u ok",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "u look sad",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "im ok sweetie mommy just tired",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "helo fr om mars",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "i com in pes",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "wat",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Yeah no worries, I get it, I've been crazy busy too",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "What have you been up to",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Anything fun or just the usual",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Been working on a new FPS game actually",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Just toying around with something in three.js nothing serious",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Oh no, what happened",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Did Mara leave you kek",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "wtf no, I got into an argument with my roommate",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Living with people is just hard",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;