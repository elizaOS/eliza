import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/ui";
import { ClawvilleDetailExtension } from "./ClawvilleDetailExtension.js";
import { ClawvilleOperatorSurface } from "./ClawvilleOperatorSurface.js";

registerOperatorSurface("@clawville/app-clawville", ClawvilleOperatorSurface);
registerDetailExtension("clawville-control", ClawvilleDetailExtension);

export { ClawvilleDetailExtension, ClawvilleOperatorSurface };
