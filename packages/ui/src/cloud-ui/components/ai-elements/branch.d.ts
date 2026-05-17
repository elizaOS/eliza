/**
 * Branch component for displaying multiple conversation branches.
 * Supports navigation between branches with previous/next controls.
 *
 * @param props.defaultBranch - Default branch index to display
 * @param props.onBranchChange - Callback when branch changes
 */
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { Button } from "../button";
export type BranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};
export declare const Branch: ({
  defaultBranch,
  onBranchChange,
  className,
  ...props
}: BranchProps) => import("react/jsx-runtime").JSX.Element;
export type BranchMessagesProps = HTMLAttributes<HTMLDivElement>;
export declare const BranchMessages: ({
  children,
  ...props
}: BranchMessagesProps) => import("react/jsx-runtime").JSX.Element[];
export type BranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};
export declare const BranchSelector: ({
  className,
  from,
  ...props
}: BranchSelectorProps) => import("react/jsx-runtime").JSX.Element | null;
export type BranchPreviousProps = ComponentProps<typeof Button>;
export declare const BranchPrevious: ({
  className,
  children,
  ...props
}: BranchPreviousProps) => import("react/jsx-runtime").JSX.Element;
export type BranchNextProps = ComponentProps<typeof Button>;
export declare const BranchNext: ({
  className,
  children,
  ...props
}: BranchNextProps) => import("react/jsx-runtime").JSX.Element;
export type BranchPageProps = HTMLAttributes<HTMLSpanElement>;
export declare const BranchPage: ({
  className,
  ...props
}: BranchPageProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=branch.d.ts.map
