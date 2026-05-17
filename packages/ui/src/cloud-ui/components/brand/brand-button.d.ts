/**
 * Brand button: flat fills, theme-token driven, xs rounding.
 *
 * @param props.asChild - If true, renders as a child component using Radix Slot
 */
import { type VariantProps } from "class-variance-authority";
import * as React from "react";
declare const brandButtonVariants: (props?: ({
    variant?: "primary" | "outline" | "ghost" | "icon" | "icon-primary" | null | undefined;
    size?: "sm" | "lg" | "icon" | "md" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export interface BrandButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof brandButtonVariants> {
    asChild?: boolean;
}
declare const BrandButton: React.ForwardRefExoticComponent<BrandButtonProps & React.RefAttributes<HTMLButtonElement>>;
export { BrandButton, brandButtonVariants };
//# sourceMappingURL=brand-button.d.ts.map