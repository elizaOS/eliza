import { Message, XMTP, xmtpClient } from "@xmtp/agent-starter";
import {
    composeContext,
    Content,
    elizaLogger,
    Memory,
    ModelClass,
    stringToUuid,
    messageCompletionFooter,
    generateMessageResponse,
    Client,
    IAgentRuntime,
} from "@elizaos/core";

let xmtp: XMTP = null;
let elizaRuntime: IAgentRuntime = null;

export const messageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export const XmtpClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        if (!xmtp) {
            elizaRuntime = runtime;

            xmtp = await xmtpClient({
                walletKey: process.env.EVM_PRIVATE_KEY as string,
                onMessage,
            });

            elizaLogger.success("✅ XMTP client started");
            elizaLogger.info(`XMTP address: ${xmtp.address}`);
            elizaLogger.info(`Talk to me on:`);
            elizaLogger.log(
                `Converse: https://converse.xyz/dm/${xmtp.address}`
            );
            elizaLogger.log(
                `Coinbase Wallet: https://go.cb-w.com/messaging?address=${xmtp.address}`
            );
            elizaLogger.log(
                `Web or Farcaster Frame: https://client.message-kit.org/?address=${xmtp.address}`
            );

            return xmtp;
        }
        return xmtp;
    },
    stop: async (_runtime: IAgentRuntime) => {
        elizaLogger.warn("XMTP client does not support stopping yet");
    },
};

const onMessage = async (message: Message) => {
    elizaLogger.info(
        `Decoded message: ${message.content?.text ?? "no text"} by ${
            message.sender.address
        }`
    );

    try {
        const text = message?.content?.text ?? "";
        const messageId = stringToUuid(message.id as string);
        const userId = stringToUuid(message.sender.address as string);
        const roomId = stringToUuid(message.group.id as string);
        await elizaRuntime.ensureConnection(
            userId,
            roomId,
            message.sender.address,
            message.sender.address,
            "xmtp"
        );

        const content: Content = {
            text,
            source: "xmtp",
            inReplyTo: undefined,
        };

        const userMessage = {
            content,
            userId,
            roomId,
            agentId: elizaRuntime.agentId,
        };

        const memory: Memory = {
            id: messageId,
            agentId: elizaRuntime.agentId,
            userId,
            roomId,
            content,
            createdAt: Date.now(),
        };

        await elizaRuntime.messageManager.createMemory(memory);

        const state = await elizaRuntime.composeState(userMessage, {
            agentName: elizaRuntime.character.name,
        });

        const context = composeContext({
            state,
            template: messageHandlerTemplate,
        });

        const response = await generateMessageResponse({
            runtime: elizaRuntime,
            context,
            modelClass: ModelClass.LARGE,
        });
        const _newMessage = [
            {
                text: response?.text,
                source: "xmtp",
                inReplyTo: messageId,
            },
        ];
        // save response to memory
        const responseMessage = {
            ...userMessage,
            userId: elizaRuntime.agentId,
            content: response,
        };

        await elizaRuntime.messageManager.createMemory(responseMessage);

        if (!response) {
            elizaLogger.error("No response from generateMessageResponse");
            return;
        }

        await elizaRuntime.evaluate(memory, state);

        const _result = await elizaRuntime.processActions(
            memory,
            [responseMessage],
            state,
            async (newMessages) => {
                if (newMessages.text) {
                    _newMessage.push({
                        text: newMessages.text,
                        source: "xmtp",
                        inReplyTo: undefined,
                    });
                }
                return [memory];
            }
        );
        for (const newMsg of _newMessage) {
            await xmtp.send({
                message: newMsg.text,
                originalMessage: message,
                metadata: {},
            });
        }
    } catch (error) {
        elizaLogger.error("Error in onMessage", error);
    }
};

export default XmtpClientInterface;
