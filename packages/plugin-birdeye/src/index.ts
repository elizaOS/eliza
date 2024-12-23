import { Plugin } from "@elizaos/core";

import { birdeyeProvider, BirdeyeProvider } from "./providers/birdeye";
import { reportToken } from "./actions/report";

export { BirdeyeProvider };

export const birdeyePlugin: Plugin = {
    name: "birdeye",
    description: "Birdeye Plugin for Eliza",
    providers: [birdeyeProvider],
    actions: [reportToken]
};

export default birdeyePlugin;
