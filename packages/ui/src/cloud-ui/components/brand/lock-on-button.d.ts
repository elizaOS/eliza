import { type VariantProps } from "class-variance-authority";
import * as React from "react";
declare const lockOnButtonVariants: (props?: ({
    variant?: "primary" | "outline" | "ghost" | "hud" | null | undefined;
    size?: "sm" | "lg" | "md" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export interface LockOnButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof lockOnButtonVariants> {
    asChild?: boolean;
    icon?: React.ReactNode;
}
export declare const LockOnButton: React.ForwardRefExoticComponent<LockOnButtonProps & React.RefAttributes<HTMLButtonElement>>;
export { lockOnButtonVariants };
//# sourceMappingURL=lock-on-button.d.ts.map