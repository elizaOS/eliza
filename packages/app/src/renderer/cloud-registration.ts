/** Public Cloud routes are composed by the app; private domains load on navigation. */
import { registerJoinFlow, registerPublicPages } from "@elizaos/ui";

let registered = false;
export function registerPublicCloudSurfaces(): void {
  if (registered) return;
  registerJoinFlow();
  registerPublicPages();
  registered = true;
}
