import { type ReactNode } from "react";
import { type PluginsViewMode } from "./plugin-list-utils";

export { paramsToSchema } from "./plugin-list-utils";
/** Plugins view — tag-filtered plugin list. */
export declare function PluginsView({
  contentHeader,
  mode,
  inModal,
  connectorDesktopPlacement,
}: {
  contentHeader?: ReactNode;
  mode?: PluginsViewMode;
  inModal?: boolean;
  connectorDesktopPlacement?: "left" | "right";
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=PluginsView.d.ts.map
