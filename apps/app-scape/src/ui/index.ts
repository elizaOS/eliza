import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { ScapeOperatorSurface } from "./ScapeOperatorSurface.js";

registerOperatorSurface("@elizaos/app-scape", ScapeOperatorSurface);

export { ScapeOperatorSurface };
