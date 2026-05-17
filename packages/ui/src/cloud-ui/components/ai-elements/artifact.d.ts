/**
 * Artifact component for displaying AI-generated artifacts.
 * Provides header, content, and close functionality with tooltip support.
 */
import { type LucideIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { Button } from "../button";
export type ArtifactProps = HTMLAttributes<HTMLDivElement>;
export declare const Artifact: ({
  className,
  ...props
}: ArtifactProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactHeaderProps = HTMLAttributes<HTMLDivElement>;
export declare const ArtifactHeader: ({
  className,
  ...props
}: ArtifactHeaderProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactCloseProps = ComponentProps<typeof Button>;
export declare const ArtifactClose: ({
  className,
  children,
  size,
  variant,
  ...props
}: ArtifactCloseProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactTitleProps = HTMLAttributes<HTMLParagraphElement>;
export declare const ArtifactTitle: ({
  className,
  ...props
}: ArtifactTitleProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactDescriptionProps = HTMLAttributes<HTMLParagraphElement>;
export declare const ArtifactDescription: ({
  className,
  ...props
}: ArtifactDescriptionProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactActionsProps = HTMLAttributes<HTMLDivElement>;
export declare const ArtifactActions: ({
  className,
  ...props
}: ArtifactActionsProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
  icon?: LucideIcon;
};
export declare const ArtifactAction: ({
  tooltip,
  label,
  icon: Icon,
  children,
  className,
  size,
  variant,
  ...props
}: ArtifactActionProps) => import("react/jsx-runtime").JSX.Element;
export type ArtifactContentProps = HTMLAttributes<HTMLDivElement>;
export declare const ArtifactContent: ({
  className,
  ...props
}: ArtifactContentProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=artifact.d.ts.map
