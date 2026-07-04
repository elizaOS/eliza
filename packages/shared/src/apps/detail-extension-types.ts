/** Types for app detail-panel extension components: the props they receive and their React component signature. */
import type { ComponentType } from "react";
import type { RegistryAppInfo } from "../contracts/apps.js";

export interface AppDetailExtensionProps {
  app: RegistryAppInfo;
}

export type AppDetailExtensionComponent =
  ComponentType<AppDetailExtensionProps>;
