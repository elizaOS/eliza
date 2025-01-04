import {
    composeContext,
    generateText,
    splitChunks,
    trimTokens,
    parseJSONObjectFromText,
} from "@elizaos/core";
import { models } from "@elizaos/core";
import { getActorDetails } from "@elizaos/core";
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
    elizaLogger,
} from "@elizaos/core";
import { ISlackService, SLACK_SERVICE_TYPE } from "../types/slack-types";

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
The "objective" is a detailed description of what the user wants to summarize based on the conversation. If they just ask for a general summary, you can either base it off the conversation if the summary range is very recent, or set the object to be general, like "a detailed summary of the conversation between all users".

The "start" and "end" are the range of dates that the user wants to summarize, relative to the current time. The format MUST be a number followed by a unit, like:
- "5 minutes ago"
- "2 hours ago"
- "1 day ago"
- "30 seconds ago"

For example:
\`\`\`json
{
  "objective": "a detailed summary of the conversation between all users",
  "start": "2 hours ago",
  "end": "0 minutes ago"
}
\`\`\`

If the user asks for "today", use "24 hours ago" as start and "0 minutes ago" as end.
If no time range is specified, default to "2 hours ago" for start and "0 minutes ago" for end.
`;

const getDateRange = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<{ objective: string; start: number; end: number } | undefined> => {
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

        const parsedResponse = parseJSONObjectFromText(response) as {
            objective: string;
            start: string | number;
            end: string | number;
        } | null;

        if (
            parsedResponse?.objective &&
            parsedResponse?.start &&
            parsedResponse?.end
        ) {
            // Parse time strings like "5 minutes ago", "2 hours ago", etc.
            const parseTimeString = (timeStr: string): number | null => {
                const match = timeStr.match(
                    /^(\d+)\s+(second|minute|hour|day)s?\s+ago$/i
                );
                if (!match) return null;

                const [_, amount, unit] = match;
                const value = parseInt(amount);

                if (isNaN(value)) return null;

                const multipliers: { [key: string]: number } = {
                    second: 1000,
                    minute: 60 * 1000,
                    hour: 60 * 60 * 1000,
                    day: 24 * 60 * 60 * 1000,
                };

                const multiplier = multipliers[unit.toLowerCase()];
                if (!multiplier) return null;

                return value * multiplier;
            };

            const startTime = parseTimeString(parsedResponse.start as string);
            const endTime = parseTimeString(parsedResponse.end as string);

            if (startTime === null || endTime === null) {
                elizaLogger.error(
                    "Invalid time format in response",
                    parsedResponse
                );
                continue;
            }

            return {
                objective: parsedResponse.objective,
                start: Date.now() - startTime,
                end: Date.now() - endTime,
            };
        }
    }

    return undefined;
};

const summarizeAction: Action = {
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
        _runtime: IAgentRuntime,
        message: Memory,
        _state: State | undefined
    ): Promise<boolean> => {
        if (message.content.source !== "slack") {
            return false;
        }

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
        _options: any,
        callback: HandlerCallback
    ): Promise<Content> => {
        const currentState = (await runtime.composeState(message)) as State;

        const callbackData: Content = {
            text: "",
            action: "SUMMARIZATION_RESPONSE",
            source: message.content.source,
            attachments: [],
        };

        // 1. Extract date range from the message
        const dateRange = await getDateRange(runtime, message, currentState);
        if (!dateRange) {
            elizaLogger.error("Couldn't determine date range from message");
            callbackData.text =
                "I couldn't determine the time range to summarize. Please try asking for a specific period like 'last hour' or 'today'.";
            await callback(callbackData);
            return callbackData;
        }

        const { objective, start, end } = dateRange;

        // 2. Get memories from the database
        const memories = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            start,
            end,
            count: 10000,
            unique: false,
        });

        if (!memories || memories.length === 0) {
            callbackData.text =
                "I couldn't find any messages in that time range to summarize.";
            await callback(callbackData);
            return callbackData;
        }

        const actors = await getActorDetails({
            runtime: runtime as IAgentRuntime,
            roomId: message.roomId,
        });

        const actorMap = new Map(actors.map((actor) => [actor.id, actor]));

        const formattedMemories = memories
            .map((memory) => {
                const actor = actorMap.get(memory.userId);
                const userName =
                    actor?.name || actor?.username || "Unknown User";
                const attachments = memory.content.attachments
                    ?.map((attachment: Media) => {
                        if (!attachment) return "";
                        return `---\nAttachment: ${attachment.id}\n${attachment.description || ""}\n${attachment.text || ""}\n---`;
                    })
                    .filter((text) => text !== "")
                    .join("\n");
                return `${userName}: ${memory.content.text}\n${attachments || ""}`;
            })
            .join("\n");

        let currentSummary = "";

        const model = models[runtime.character.modelProvider];
        const chunkSize = model.settings.maxOutputTokens;

        const chunks = await splitChunks(formattedMemories, chunkSize, 0);

        currentState.memoriesWithAttachments = formattedMemories;
        currentState.objective = objective;

        // Only process one chunk at a time and stop after getting a valid summary
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            currentState.currentSummary = currentSummary;
            currentState.currentChunk = chunk;

            const template = await trimTokens(
                summarizationTemplate,
                chunkSize + 500,
                runtime
            );

            const context = composeContext({
                state: currentState,
                template,
            });

            const summary = await generateText({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (summary) {
                currentSummary = currentSummary + "\n" + summary;
                break; // Stop after getting first valid summary
            }
        }

        if (!currentSummary.trim()) {
            callbackData.text =
                "I wasn't able to generate a summary of the conversation.";
            await callback(callbackData);
            return callbackData;
        }

        // Format dates consistently
        const formatDate = (timestamp: number) => {
            const date = new Date(timestamp);
            const pad = (n: number) => (n < 10 ? `0${n}` : n);
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        };

        try {
            // Get the user's name for the summary header
            const requestingUser = actorMap.get(message.userId);
            const userName =
                requestingUser?.name ||
                requestingUser?.username ||
                "Unknown User";

            const summaryContent = `Summary of conversation from ${formatDate(start)} to ${formatDate(end)}

Here is a detailed summary of the conversation between ${userName} and ${runtime.character.name}:\n\n${currentSummary.trim()}`;

            // If summary is long, upload as a file
            if (summaryContent.length > 1000) {
                const summaryFilename = `summary_${Date.now()}.txt`;
                elizaLogger.debug("Uploading summary file to Slack...");

                try {
                    // Save file content
                    await runtime.cacheManager.set(
                        summaryFilename,
                        summaryContent
                    );

                    // Get the Slack service from runtime
                    const slackService = runtime.getService(
                        SLACK_SERVICE_TYPE
                    ) as ISlackService;
                    if (!slackService?.client) {
                        elizaLogger.error(
                            "Slack service not found or not properly initialized"
                        );
                        throw new Error("Slack service not found");
                    }

                    // Upload file using Slack's API
                    elizaLogger.debug(
                        `Uploading file ${summaryFilename} to channel ${message.roomId}`
                    );
                    const uploadResult = await slackService.client.files.upload(
                        {
                            channels: message.roomId,
                            filename: summaryFilename,
                            title: "Conversation Summary",
                            content: summaryContent,
                            initial_comment: `I've created a summary of the conversation from ${formatDate(start)} to ${formatDate(end)}.`,
                        }
                    );

                    if (uploadResult.ok) {
                        elizaLogger.success(
                            "Successfully uploaded summary file to Slack"
                        );
                        callbackData.text = `I've created a summary of the conversation from ${formatDate(start)} to ${formatDate(end)}. You can find it in the thread above.`;
                    } else {
                        elizaLogger.error(
                            "Failed to upload file to Slack:",
                            uploadResult.error
                        );
                        throw new Error("Failed to upload file to Slack");
                    }
                } catch (error) {
                    elizaLogger.error("Error uploading summary file:", error);
                    // Fallback to sending as a message
                    callbackData.text = summaryContent;
                }
            } else {
                // For shorter summaries, just send as a message
                callbackData.text = summaryContent;
            }

            await callback(callbackData);
            return callbackData;
        } catch (error) {
            elizaLogger.error("Error in summary generation:", error);
            callbackData.text =
                "I encountered an error while generating the summary. Please try again.";
            await callback(callbackData);
            return callbackData;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you give me a detailed report on what we're talking about?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze the conversation and provide a summary for you.",
                    action: "SUMMARIZE_CONVERSATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please summarize our discussion from the last hour, including any shared files.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll review the conversation and shared content to create a comprehensive summary.",
                    action: "SUMMARIZE_CONVERSATION",
                },
            },
        ],
    ] as ActionExample[][],
};

export default summarizeAction;
