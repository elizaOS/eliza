import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { registerDetailExtension } from "@elizaos/app-core/components/apps/extensions/registry";
import { HyperscapeOperatorSurface } from "./HyperscapeOperatorSurface.js";
import { HyperscapeDetailExtension } from "./HyperscapeDetailExtension.js";

registerOperatorSurface("@elizaos/app-hyperscape", HyperscapeOperatorSurface);
registerOperatorSurface("@hyperscape/plugin-hyperscape", HyperscapeOperatorSurface);
registerDetailExtension("hyperscape-embedded-agents", HyperscapeDetailExtension);

export { HyperscapeOperatorSurface, HyperscapeDetailExtension };
