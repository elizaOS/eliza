import {
    Action,
    composeContext,
    elizaLogger,
    generateText,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
import { SendEmailParams } from "../types";

const emailTemplate = `Based on the user's message: "{{message}}"

Extract and format the email details in this exact format:
To: [recipient email]
Subject: [email subject]
Message: [email content]

For example, if the message is "send an email to john@example.com about Meeting saying Let's meet tomorrow", the output should be:
To: john@example.com
Subject: Meeting
Message: Let's meet tomorrow`;

export class SendEmailAction {
    constructor() {
        if (!global.mailService) {
            throw new Error("Mail service not initialized");
        }
    }

    async send(
        params: SendEmailParams
    ): Promise<{ success: boolean; message: string }> {
        elizaLogger.info("Sending email with params", { params });

        if (!params.to) {
            throw new Error("Recipient (to) is required");
        }

        if (!params.subject) {
            throw new Error("Subject is required");
        }

        if (!params.text) {
            throw new Error("Email text content is required");
        }

        await global.mailService.sendEmail(
            params.to,
            params.subject,
            params.text,
            params.html
        );

        return { success: true, message: `Email sent to ${params.to}` };
    }
}

export const sendEmailAction: Action = {
    name: "sendEmail",
    description: "Send an email to a recipient",
    similes: ["send", "compose", "write", "email"],
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "send an email to john@example.com about Meeting saying Let's meet tomorrow",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "write an email to sarah@example.com with subject Project Update saying Here's the latest progress on the project",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "email the report to team@company.com",
                },
            },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        const action = new SendEmailAction();

        const emailContext = composeContext({
            state: {
                ...state,
                message: message.content.text,
            },
            template: emailTemplate,
            templatingEngine: "handlebars",
        });

        const response = await generateText({
            runtime,
            context: emailContext,
            modelClass: ModelClass.LARGE,
        });

        // Parse the response to extract email parameters
        const lines = response.split("\n");
        const params: SendEmailParams = {
            to: "",
            subject: "",
            text: "",
        };

        for (const line of lines) {
            if (line.startsWith("To:")) {
                params.to = line.replace("To:", "").trim();
            } else if (line.startsWith("Subject:")) {
                params.subject = line.replace("Subject:", "").trim();
            } else if (line.startsWith("Message:")) {
                params.text = line.replace("Message:", "").trim();
            }
        }

        try {
            const result = await action.send(params);

            if (callback) {
                await callback({
                    text: result.message,
                });
            }
            return true;
        } catch (error: any) {
            elizaLogger.error("Error in send email handler:", {
                code: error.code,
                command: error.command,
                message: error.message,
                stack: error.stack,
            });
            if (callback) {
                await callback({
                    text: `Failed to send email: ${error.message}`,
                });
            }
            return false;
        }
    },
    validate: async (runtime: IAgentRuntime) => {
        return !!global.mailService;
    },
};
