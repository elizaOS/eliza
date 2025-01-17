import { Plugin } from "@elizaos/core";
import { fetchMatchAction } from "./actions/fetchMatchAction.ts";

export const footballPlugin: Plugin = {
    name: "football",
    description:
        "Football data plugin to fetch live scores, standings, and fixtures",
    actions: [fetchMatchAction],
};
export default footballPlugin;
