import type { ReactNode } from "react";

export interface DetailsViewHeaderActionsProps {
  /**
   * Custom actions to render in the header
   */
  children?: ReactNode;
  /**
   * Optional className for the actions container
   */
  className?: string;
}

export const DetailsViewHeaderActions = ({
  children,
  className = "flex flex-wrap items-center gap-2",
}: DetailsViewHeaderActionsProps) => {
  if (!children) return null;

  return <div className={className}>{children}</div>;
};
