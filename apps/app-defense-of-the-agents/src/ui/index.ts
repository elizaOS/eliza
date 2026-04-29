import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core";
import { DefenseAgentsDetailExtension } from "./DefenseAgentsDetailExtension.js";
import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface.js";

registerOperatorSurface(
  "@elizaos/app-defense-of-the-agents",
  DefenseAgentsOperatorSurface,
);
registerDetailExtension("defense-agent-control", DefenseAgentsDetailExtension);

export { DefenseAgentsDetailExtension, DefenseAgentsOperatorSurface };
