import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core";
import { BabylonDetailExtension } from "./BabylonDetailExtension.js";
import { BabylonOperatorSurface } from "./BabylonOperatorSurface.js";

registerOperatorSurface("@elizaos/app-babylon", BabylonOperatorSurface);
registerDetailExtension("babylon-operator-dashboard", BabylonDetailExtension);

export * from "./babylon-data.js";
export { BabylonDetailExtension, BabylonOperatorSurface };
