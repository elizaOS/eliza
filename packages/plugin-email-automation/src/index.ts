import { Plugin } from "@elizaos/core";
import { EmailAutomationService } from "./services/emailAutomationService";

export const emailAutomationPlugin: Plugin = {
    name: "email-automation",
    description: "AI-powered email automation plugin for Eliza",
    services: [new EmailAutomationService()],
    clients: [],
    evaluators: [],
    providers: [],
};

export default emailAutomationPlugin;
