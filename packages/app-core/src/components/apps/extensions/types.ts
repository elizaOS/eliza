import type { ComponentType } from "react";
import type { RegistryAppInfo } from "../../../api";

export interface AppDetailExtensionProps {
  app: RegistryAppInfo;
}

export type AppDetailExtensionComponent =
  ComponentType<AppDetailExtensionProps>;
