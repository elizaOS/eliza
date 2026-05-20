import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core/ui-compat";
import { FeedDetailExtension } from "./FeedDetailExtension.js";
import { FeedOperatorSurface } from "./FeedOperatorSurface.js";

registerOperatorSurface("@elizaos/plugin-feed", FeedOperatorSurface);
registerDetailExtension("feed-operator-dashboard", FeedDetailExtension);

export * from "./feed-data.js";
export { FeedDetailExtension, FeedOperatorSurface };
