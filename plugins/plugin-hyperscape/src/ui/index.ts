import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core/ui-compat";
import { HyperscapeDetailExtension } from "./HyperscapeDetailExtension.js";
import { HyperscapeOperatorSurface } from "./HyperscapeOperatorSurface.js";

registerOperatorSurface(
  "@elizaos/plugin-hyperscape",
  HyperscapeOperatorSurface,
);
registerOperatorSurface(
  "@hyperscape/plugin-hyperscape",
  HyperscapeOperatorSurface,
);
registerDetailExtension(
  "hyperscape-embedded-agents",
  HyperscapeDetailExtension,
);

export { HyperscapeDetailExtension, HyperscapeOperatorSurface };
