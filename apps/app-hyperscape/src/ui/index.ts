import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core";
import { HyperscapeDetailExtension } from "./HyperscapeDetailExtension.js";
import { HyperscapeOperatorSurface } from "./HyperscapeOperatorSurface.js";

registerOperatorSurface("@elizaos/app-hyperscape", HyperscapeOperatorSurface);
registerOperatorSurface(
  "@hyperscape/plugin-hyperscape",
  HyperscapeOperatorSurface,
);
registerDetailExtension(
  "hyperscape-embedded-agents",
  HyperscapeDetailExtension,
);

export { HyperscapeDetailExtension, HyperscapeOperatorSurface };
