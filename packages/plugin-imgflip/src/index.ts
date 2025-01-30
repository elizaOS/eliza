import { Plugin } from "@elizaos/core";
import { generateMemeAction, generateMemeActionHandler, Meme } from "./actions";

export { generateMemeAction, generateMemeActionHandler, Meme };

export const imgflipPlugin: Plugin = {
    name: "imgflip",
    description: "Generate memes using imgflip.com",
    actions: [generateMemeAction],
    evaluators: [],
    providers: [],
};
export default imgflipPlugin;
