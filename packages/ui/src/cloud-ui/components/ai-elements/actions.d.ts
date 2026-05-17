/**
 * Actions component container for action buttons with tooltip support.
 * Provides Action component for individual action buttons with optional tooltips.
 */
import type { ComponentProps } from "react";
import { Button } from "../button";
export type ActionsProps = ComponentProps<"div">;
export declare const Actions: ({
  className,
  children,
  ...props
}: ActionsProps) => import("react/jsx-runtime").JSX.Element;
export type ActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};
export declare const Action: ({
  tooltip,
  children,
  label,
  className,
  variant,
  size,
  ...props
}: ActionProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=actions.d.ts.map
