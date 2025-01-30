import { Evaluator, Memory, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { EmailAutomationService } from "../services/emailAutomationService";

export const emailEvaluator: Evaluator = {
    name: "EMAIL_AUTOMATION",
    description: "Evaluates messages for potential email triggers",
    similes: [
        "Checks if a message warrants sending an email",
        "Monitors conversation for email-worthy interactions",
        "Evaluates if email follow-up is needed"
    ],
    alwaysRun: true,
    examples: [{
        context: "User expresses interest in business opportunity",
        messages: [{
            user: "user123",
            content: {
                text: "I'd like to discuss a potential partnership"
            }
        }],
        outcome: "Should trigger email automation"
    }],
    validate: async () => true,
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            const emailService = runtime.getService(EmailAutomationService.serviceType) as EmailAutomationService;
            if (!emailService) {
                elizaLogger.warn("📧 Email automation service not available");
                return;
            }

            await emailService.evaluateMessage(message);
        } catch (error) {
            elizaLogger.error("📧 Error in email evaluator:", error);
        }
    }
};