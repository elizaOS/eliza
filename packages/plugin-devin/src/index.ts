import type { Plugin } from "@elizaos/core";
import { startSessionAction } from "./actions/startSession";
import { devinProvider } from "./providers/devinProvider";
import { validateDevinConfig } from "./environment";

export const devinPlugin: Plugin = {
    name: "devinPlugin",
    description: "Integrates Devin API with Eliza for task automation and session management",
    actions: [startSessionAction],
    providers: [devinProvider],
};
