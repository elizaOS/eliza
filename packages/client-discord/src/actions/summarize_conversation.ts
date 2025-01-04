import { composeContext } from "@elizaos/core";
import { generateText, splitChunks, trimTokens } from "@elizaos/core";
import { getActorDetails } from "@elizaos/core";
import { models } from "@elizaos/core";
import { parseJSONObjectFromText } from "@elizaos/core";
import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Media,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
export const summarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current conversation chunk we are summarizing (includes attachments)
{{memoriesWithAttachments}}

Summarization objective: {{objective}}

# Instructions: Summarize the conversation so far. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details to the objective. Only respond with the new summary text.
Your response should be extremely detailed and include any and all relevant information.`;

export const dateRangeTemplate = `# Messages we are summarizing (the conversation is continued after this)
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of the conversation. Your goal is to determine their objective, along with the range of dates that their request covers.
The "objective" is a detailed description of what the user wants to summarize based on the conversation. If they just ask for a general summary, you can either base it off the converation if the summary range is very recent, or set the object to be general, like "a detailed summary of the conversation between all users".
The "start" and "end" are the range of dates that the user wants to summarize, relative to the current time. The start and end should be relative to the current time, and measured in seconds, minutes, hours and days. The format is "2 days ago" or "3 hours ago" or "4 minutes ago" or "5 seconds ago", i.e. "<integer> <unit> ago".
If you aren't sure, you can use a default range of "0 minutes ago" to "2 hours ago" or more. Better to err on the side of including too much than too little.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "start": "0 minutes ago",
  "end": "2 hours ago"
}
\`\`\`
`;

const getDateRange = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
) => {
    state = (await runtime.composeState(message)) as State;

    const context = composeContext({
        state,
        template: dateRangeTemplate,
    });

    for (let i = 0; i < 5; i++) {
        const response = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        console.log("response", response);
        // try parsing to a json object
        const parsedResponse = parseJSONObjectFromText(response) as {
            objective: string;
            start: string | number;
            end: string | number;
        } | null;
        // see if it contains objective, start and end
        if (parsedResponse) {
            if (
                parsedResponse.objective &&
                parsedResponse.start &&
                parsedResponse.end
            ) {
                // TODO: parse start and end into timestamps
                const startIntegerString = (
                    parsedResponse.start as string
                ).match(/\d+/)?.[0];
                const endIntegerString = (parsedResponse.end as string).match(
                    /\d+/
                )?.[0];

                // parse multiplier
                const multipliers = {
                    second: 1 * 1000,
                    minute: 60 * 1000,
                    hour: 3600 * 1000,
                    day: 86400 * 1000,
                };

                const startMultiplier = (parsedResponse.start as string).match(
                    /second|minute|hour|day/
                )?.[0];
                const endMultiplier = (parsedResponse.end as string).match(
                    /second|minute|hour|day/
                )?.[0];

                const startInteger = startIntegerString
                    ? parseInt(startIntegerString)
                    : 0;
                const endInteger = endIntegerString
                    ? parseInt(endIntegerString)
                    : 0;

                // multiply by multiplier
                const startTime =
                    startInteger *
                    multipliers[startMultiplier as keyof typeof multipliers];

                console.log("startTime", startTime);

                const endTime =
                    endInteger *
                    multipliers[endMultiplier as keyof typeof multipliers];

                console.log("endTime", endTime);

                // get the current time and subtract the start and end times
                parsedResponse.start = Date.now() - startTime;
                parsedResponse.end = Date.now() - endTime;

                return parsedResponse;
            }
        }
    }
};

const summarizeAction = {
    name: "SUMMARIZE_CONVERSATION",
    similes: [
        "RECAP",
        "RECAP_CONVERSATION",
        "SUMMARIZE_CHAT",
        "SUMMARIZATION",
        "CHAT_SUMMARY",
        "CONVERSATION_SUMMARY",
    ],
    description: "Summarizes the conversation and attachments.",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State
    ) => {
        if (message.content.source !== "discord") {
            return false;
        }
        // only show if one of the keywords are in the message
        const keywords: string[] = [
            "summarize",
            "summarization",
            "summary",
            "recap",
            "report",
            "overview",
            "review",
            "rundown",
            "wrap-up",
            "brief",
            "debrief",
            "abstract",
            "synopsis",
            "outline",
            "digest",
            "abridgment",
            "condensation",
            "encapsulation",
            "essence",
            "gist",
            "main points",
            "key points",
            "key takeaways",
            "bulletpoint",
            "highlights",
            "tldr",
            "tl;dr",
            "in a nutshell",
            "bottom line",
            "long story short",
            "sum up",
            "sum it up",
            "short version",
            "bring me up to speed",
            "catch me up",
        ];
        return keywords.some((keyword) =>
            message.content.text.toLowerCase().includes(keyword.toLowerCase())
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        state = (await runtime.composeState(message)) as State;

        const callbackData: Content = {
            text: "", // fill in later
            action: "SUMMARIZATION_RESPONSE",
            source: message.content.source,
            attachments: [],
        };
        const { roomId } = message;

        // 1. extract date range from the message
        const dateRange = await getDateRange(runtime, message, state);
        if (!dateRange) {
            console.error("Couldn't get date range from message");
            return;
        }

        console.log("dateRange", dateRange);

        const { objective, start, end } = dateRange;

        // 2. get these memories from the database
        const memories = await runtime.messageManager.getMemories({
            roomId,
            // subtract start from current time
            start: parseInt(start as string),
            end: parseInt(end as string),
            count: 10000,
            unique: false,
        });

        const actors = await getActorDetails({
            runtime: runtime as IAgentRuntime,
            roomId,
        });

        const actorMap = new Map(actors.map((actor) => [actor.id, actor]));

        const formattedMemories = memories
            .map((memory) => {
                const attachments = memory.content.attachments
                    ?.map((attachment: Media) => {
                        return `---\nAttachment: ${attachment.id}\n${attachment.description}\n${attachment.text}\n---`;
                    })
                    .join("\n");
                return `${actorMap.get(memory.userId)?.name ?? "Unknown User"} (${actorMap.get(memory.userId)?.username ?? ""}): ${memory.content.text}\n${attachments}`;
            })
            .join("\n");

        let currentSummary = "";

        const model = models[runtime.character.settings.model];
        const chunkSize = model.settings.maxContextLength - 1000;

        const chunks = await splitChunks(formattedMemories, chunkSize, 0);

        const _datestr = new Date().toUTCString().replace(/:/g, "-");

        state.memoriesWithAttachments = formattedMemories;
        state.objective = objective;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            state.currentSummary = currentSummary;
            state.currentChunk = chunk;
            const template = await trimTokens(
                summarizationTemplate,
                chunkSize + 500,
                runtime
            );
            const context = composeContext({
                state,
                // make sure it fits, we can pad the tokens a bit
                template,
            });

            const summary = await generateText({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            currentSummary = currentSummary + "\n" + summary;
        }

        if (!currentSummary) {
            console.error("No summary found, that's not good!");
            return;
        }

        callbackData.text = currentSummary.trim();
        if (
            callbackData.text &&
            (currentSummary.trim()?.split("\n").length < 4 ||
                currentSummary.trim()?.split(" ").length < 100)
        ) {
            callbackData.text = `Here is the summary:
\`\`\`md
${currentSummary.trim()}
\`\`\`
`;
            await callback(callbackData);
        } else if (currentSummary.trim()) {
            const summaryFilename = `content/conversation_summary_${Date.now()}`;
            await runtime.cacheManager.set(summaryFilename, currentSummary);
            // save the summary to a file
            await callback(
                {
                    ...callbackData,
                    text: `I've attached the summary of the conversation from \`${new Date(parseInt(start as string)).toString()}\` to \`${new Date(parseInt(end as string)).toString()}\` as a text file.`,
                },
                [summaryFilename]
            );
        } else {
            console.warn(
                "Empty response from summarize conversation action, skipping"
            );
        }

        return callbackData;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "```js\nconst x = 10\n```",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "can you give me a detailed report on what we're talking about?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sure, no problem, give me a minute to get that together for you",
                    action: "SUMMARIZE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "please summarize the conversation we just had and include this blogpost i'm linking (Attachment: b3e12)",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sure, give me a sec",
                    action: "SUMMARIZE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you summarize what moon and avf are talking about?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Yeah, just hold on a second while I get that together for you...",
                    action: "SUMMARIZE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "i need to write a blog post about farming, can you summarize the discussion from a few hours ago?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "no probblem, give me a few minutes to read through everything",
                    action: "SUMMARIZE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

export default summarizeAction;
