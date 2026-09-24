/** Exposes shared UI primitives, spatial authoring components, API client, and login hooks. */

export { client } from "./api/client.js";
export {
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  registerAppShellPage,
} from "./app-shell-registry.js";
export * from "./components/primitives/index";
export * from "./hooks/resource-cache.js";
export { cn } from "./lib/utils";
export * from "./login/index";
export * from "./login/wallet/index";
export {
  Button as SpatialButton,
  Card as SpatialCard,
  Divider as SpatialDivider,
  HStack as SpatialHStack,
  List as SpatialList,
  Text as SpatialText,
  VStack as SpatialVStack,
} from "./spatial/index.ts";
