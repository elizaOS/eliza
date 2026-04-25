import { registerDetailExtension } from "@elizaos/app-core/components/apps/extensions/registry";
import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { ClawvilleDetailExtension } from "./ClawvilleDetailExtension.js";
import { ClawvilleOperatorSurface } from "./ClawvilleOperatorSurface.js";

registerOperatorSurface("@clawville/app-clawville", ClawvilleOperatorSurface);
registerDetailExtension("clawville-control", ClawvilleDetailExtension);

export { ClawvilleDetailExtension, ClawvilleOperatorSurface };
