/** Types for app detail-panel extension components: the props they receive and their React component signature. */

import type { RegistryAppInfo } from "@elizaos/core/contracts/apps";
import type { ComponentType } from "react";

export interface AppDetailExtensionProps {
  app: RegistryAppInfo;
}

export type AppDetailExtensionComponent =
  ComponentType<AppDetailExtensionProps>;
