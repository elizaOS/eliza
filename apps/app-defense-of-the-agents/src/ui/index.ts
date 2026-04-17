import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { registerDetailExtension } from "@elizaos/app-core/components/apps/extensions/registry";
import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface.js";
import { DefenseAgentsDetailExtension } from "./DefenseAgentsDetailExtension.js";

registerOperatorSurface("@elizaos/app-defense-of-the-agents", DefenseAgentsOperatorSurface);
registerDetailExtension("defense-agent-control", DefenseAgentsDetailExtension);

export { DefenseAgentsOperatorSurface, DefenseAgentsDetailExtension };
