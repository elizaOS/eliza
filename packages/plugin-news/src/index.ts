import { Plugin } from "@elizaos/core";
import { currentNewsAction } from "./actions/news";

export const newsPlugin: Plugin = {
    name: "newsPlugin",
    description: "Get the latest news about a specific topic if asked by the user.",
    actions: [currentNewsAction],
};

export default newsPlugin;
