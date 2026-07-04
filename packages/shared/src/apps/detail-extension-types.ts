import type { ComponentType } from "react";
import type { RegistryAppInfo } from "../contracts/apps.js";

export interface AppDetailExtensionProps {
  app: RegistryAppInfo;
}

export type AppDetailExtensionComponent =
  ComponentType<AppDetailExtensionProps>;
