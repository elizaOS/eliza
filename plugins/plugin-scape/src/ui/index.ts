import { registerOperatorSurface } from "@elizaos/app-core";
import { ScapeOperatorSurface } from "./ScapeOperatorSurface.js";

registerOperatorSurface("@elizaos/plugin-scape", ScapeOperatorSurface);

export { ScapeOperatorSurface };
