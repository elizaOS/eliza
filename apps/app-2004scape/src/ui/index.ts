import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { registerDetailExtension } from "@elizaos/app-core/components/apps/extensions/registry";
import { TwoThousandFourScapeOperatorSurface } from "./TwoThousandFourScapeOperatorSurface.js";
import { TwoThousandFourScapeDetailExtension } from "./TwoThousandFourScapeDetailExtension.js";

registerOperatorSurface("@elizaos/app-2004scape", TwoThousandFourScapeOperatorSurface);
registerDetailExtension("2004scape-operator-dashboard", TwoThousandFourScapeDetailExtension);

export { TwoThousandFourScapeOperatorSurface, TwoThousandFourScapeDetailExtension };
