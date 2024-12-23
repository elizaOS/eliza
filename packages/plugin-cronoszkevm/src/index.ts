import { Plugin } from "@ai16z/eliza";

import transfer from "./actions/transfer";

export const cronosZkEVMPlugin: Plugin = {
    name: "cronoszkevm",
    description: "Cronos zkEVM plugin for Eliza",
    actions: [transfer],
    evaluators: [],
    providers: [],
};

export default cronosZkEVMPlugin;
