import { Plugin } from "@elizaos/core";
import { auditAction } from "./actions/audit";

export const quickIntelPlugin: Plugin = {
    name: "Quick Intel",
    description: "QuickIntel Plugin for Eliza - Enables token security analysis",
    actions: [auditAction],
    providers: [],
    evaluators: [],
    services: []
};

export default quickIntelPlugin;