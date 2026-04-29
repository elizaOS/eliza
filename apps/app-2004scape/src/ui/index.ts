import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core";
import { TwoThousandFourScapeDetailExtension } from "./TwoThousandFourScapeDetailExtension.js";
import { TwoThousandFourScapeOperatorSurface } from "./TwoThousandFourScapeOperatorSurface.js";

registerOperatorSurface(
  "@elizaos/app-2004scape",
  TwoThousandFourScapeOperatorSurface,
);
registerDetailExtension(
  "2004scape-operator-dashboard",
  TwoThousandFourScapeDetailExtension,
);

export {
  TwoThousandFourScapeDetailExtension,
  TwoThousandFourScapeOperatorSurface,
};
