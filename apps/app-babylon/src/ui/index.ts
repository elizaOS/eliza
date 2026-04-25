import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { registerDetailExtension } from "@elizaos/app-core/components/apps/extensions/registry";
import { BabylonOperatorSurface } from "./BabylonOperatorSurface.js";
import { BabylonDetailExtension } from "./BabylonDetailExtension.js";

registerOperatorSurface("@elizaos/app-babylon", BabylonOperatorSurface);
registerDetailExtension("babylon-operator-dashboard", BabylonDetailExtension);

export { BabylonOperatorSurface, BabylonDetailExtension };
