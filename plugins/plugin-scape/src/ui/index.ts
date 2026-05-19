import { registerOperatorSurface } from "@elizaos/app-core/ui-compat";
import { ScapeOperatorSurface } from "./ScapeOperatorSurface.js";

registerOperatorSurface("@elizaos/plugin-scape", ScapeOperatorSurface);

export { ScapeOperatorSurface };
