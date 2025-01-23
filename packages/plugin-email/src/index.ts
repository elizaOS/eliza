import type { Plugin } from "@elizaos/core";
import { EmailClientInterface } from "./clients/emailClient";

export const emailPlugin: Plugin = {
    name: "email",
    description: "Email plugin for Eliza",
    clients: [EmailClientInterface],
    actions: [],
    evaluators: [],
    services: [],
};

export * from "./types";

export default emailPlugin;
