import { Plugin } from "@elizaos/core";
import transfer from "./actions/transfer";
import { MplBubblegumProvider } from "./providers/bubblegumProvider";

export { MplBubblegumProvider };

export const mplBubblegumPlugin: Plugin = {
    name: "mpl-bubblegum",
    description: "Bubblegum Plugin for Eliza",
    actions: [transfer],
    providers: [],
    evaluators: [],
    services: [],
    clients: [],
};
