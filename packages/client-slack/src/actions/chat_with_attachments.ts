import {
    composeContext,
    generateText,
    trimTokens,
    parseJSONObjectFromText,
} from "@elizaos/core";
import { models } from "@elizaos/core";
import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    Handler,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";

export const summarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current attachments we are summarizing
{{attachmentsWithText}}

Summarization objective: {{objective}}

# Instructions: Summarize the attachments. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details based on the objective. Only respond with the new summary text.`;

export const attachmentIdsTemplate = `# Messages we are summarizing
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of specific attachments. Your goal is to determine their objective, along with the list of attachment IDs to summarize.
The "objective" is a detailed description of what the user wants to summarize based on the conversation.
The "attachmentIds" is an array of attachment IDs that the user wants to summarize. If not specified, default to including all attachments from the conversation.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "attachmentIds": ["<Attachment ID 1>", "<Attachment ID 2>", ...]
}
\`\`\`
`;

const getAttachmentIds = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<{ objective: string; attachmentIds: string[] } | null> => {
    const context = composeContext({
        state,
        template: attachmentIdsTemplate,
    });

    for (let i = 0; i < 5; i++) {
        const response = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        const parsedResponse = parseJSONObjectFromText(response) as {
            objective: string;
            attachmentIds: string[];
        } | null;

        if (parsedResponse?.objective && parsedResponse?.attachmentIds) {
            return parsedResponse;
        }
    }
    return null;
};

const summarizeAction: Action = {
    name: "CHAT_WITH_ATTACHMENTS",
    similes: [
        "CHAT_WITH_ATTACHMENT",
        "SUMMARIZE_FILES",
        "SUMMARIZE_FILE",
        "SUMMARIZE_ATACHMENT",
        "CHAT_WITH_PDF",
        "ATTACHMENT_SUMMARY",
        "RECAP_ATTACHMENTS",
        "SUMMARIZE_FILE",
        "SUMMARIZE_VIDEO",
        "SUMMARIZE_AUDIO",
        "SUMMARIZE_IMAGE",
        "SUMMARIZE_DOCUMENT",
        "SUMMARIZE_LINK",
        "ATTACHMENT_SUMMARY",
        "FILE_SUMMARY",
    ],
    description:
        "Answer a user request informed by specific attachments based on their IDs. If a user asks to chat with a PDF, or wants more specific information about a link or video or anything else they've attached, this is the action to use.",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | undefined
    ): Promise<boolean> => {
        if (message.content.source !== "slack") {
            return false;
        }

        const keywords: string[] = [
            "attachment",
            "summary",
            "summarize",
            "research",
            "pdf",
            "video",
            "audio",
            "image",
            "document",
            "link",
            "file",
            "attachment",
            "summarize",
            "code",
            "report",
            "write",
            "details",
            "information",
            "talk",
            "chat",
            "read",
            "listen",
            "watch",
        ];

        return keywords.some((keyword) =>
            message.content.text.toLowerCase().includes(keyword.toLowerCase())
        );
    },
    handler: (async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        options: any,
        callback: HandlerCallback
    ): Promise<Content> => {
        const currentState =
            state ?? ((await runtime.composeState(message)) as State);

        const callbackData: Content = {
            text: "",
            action: "CHAT_WITH_ATTACHMENTS_RESPONSE",
            source: message.content.source,
            attachments: [],
        };

        const attachmentData = await getAttachmentIds(
            runtime,
            message,
            currentState
        );
        if (!attachmentData) {
            console.error("Couldn't get attachment IDs from message");
            await callback(callbackData);
            return callbackData;
        }

        const { objective, attachmentIds } = attachmentData;

        const attachments = currentState.recentMessagesData
            .filter(
                (msg) =>
                    msg.content.attachments &&
                    msg.content.attachments.length > 0
            )
            .flatMap((msg) => msg.content.attachments)
            .filter((attachment) => {
                if (!attachment) return false;
                return (
                    attachmentIds
                        .map((attch) => attch.toLowerCase().slice(0, 5))
                        .includes(attachment.id.toLowerCase().slice(0, 5)) ||
                    attachmentIds.some((id) => {
                        const attachmentId = id.toLowerCase().slice(0, 5);
                        return attachment.id
                            .toLowerCase()
                            .includes(attachmentId);
                    })
                );
            });

        const attachmentsWithText = attachments
            .map((attachment) => {
                if (!attachment) return "";
                return `# ${attachment.title}\n${attachment.text}`;
            })
            .filter((text) => text !== "")
            .join("\n\n");

        let currentSummary = "";

        const model = models[runtime.character.modelProvider];
        const chunkSize = model.settings.maxOutputTokens;

        currentState.attachmentsWithText = attachmentsWithText;
        currentState.objective = objective;

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

        currentSummary = currentSummary + "\n" + summary;

        if (!currentSummary) {
            console.error("No summary found!");
            await callback(callbackData);
            return callbackData;
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
            const summaryFilename = `content/summary_${Date.now()}`;
            await runtime.cacheManager.set(summaryFilename, currentSummary);

            callbackData.text = `I've attached the summary of the requested attachments as a text file.`;
            await callback(callbackData, [summaryFilename]);
        } else {
            await callback(callbackData);
        }

        return callbackData;
    }) as Handler,
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you summarize the PDF I just shared?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze the PDF and provide a summary for you.",
                    action: "CHAT_WITH_ATTACHMENTS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Could you look at these documents and tell me what they're about?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll review the documents and provide a summary of their contents.",
                    action: "CHAT_WITH_ATTACHMENTS",
                },
            },
        ],
    ] as ActionExample[][],
};

export default summarizeAction;
