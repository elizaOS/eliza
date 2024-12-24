import { Plugin } from "@ai16z/eliza";
import { ragGraphProvider } from "./provider";

export const raggraphPlugin: Plugin = {
    name: "raggraph",
    description: "RAGGraph Plugin for Eliza",
    actions: [],
    evaluators: [],
    providers: [ragGraphProvider],
};

export default raggraphPlugin;
