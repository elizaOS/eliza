import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const bannerVariants: (
  props?:
    | ({
        variant?: "info" | "error" | "warning" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface BannerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof bannerVariants> {
  /** Optional action element (button, link) */
  action?: React.ReactNode;
  /** Show dismiss button */
  dismissible?: boolean;
  /** Called when dismiss is clicked */
  onDismiss?: () => void;
  /** Aria-label for dismiss button */
  dismissLabel?: string;
}
export declare const Banner: React.ForwardRefExoticComponent<
  BannerProps & React.RefAttributes<HTMLDivElement>
>;
//# sourceMappingURL=banner.d.ts.map
