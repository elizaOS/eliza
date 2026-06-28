/**
 * ContentLayout — single-pane layout shell for views without a sidebar.
 *
 * Uses the same shared workspace shell as PageLayout, but keeps the
 * content header inside the scrollable column for single-pane pages.
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { WorkspaceLayout } from "../workspace-layout";

export interface ContentLayoutProps {
  /** Optional header rendered above the content (e.g. SegmentedControl nav). */
  contentHeader?: ReactNode;
  /** Content body. */
  children: ReactNode;
  /** When true, strips outer padding for modal embedding. */
  inModal?: boolean;
  /** Additional classes on the outer scroll container. */
  className?: string;
  /** Additional classes on the inner content wrapper. */
  contentClassName?: string;
}

export function ContentLayout({
  contentHeader,
  children,
  inModal,
  className,
  contentClassName,
}: ContentLayoutProps) {
  return (
    <WorkspaceLayout
      className={cn(!inModal && "eliza-content-layout", className)}
      contentClassName={contentClassName}
      contentHeader={contentHeader}
      contentPadding={!inModal}
      headerPlacement="inside"
    >
      {children}
    </WorkspaceLayout>
  );
}
