/**
 * Brand card: flat surface, theme-token driven, xs rounding, with optional corner brackets.
 *
 * @param props.hover - Enable hover treatment (border + bg shift)
 * @param props.corners - Render corner brackets
 * @param props.cornerSize - Corner bracket size
 * @param props.cornerColor - Corner bracket color override (defaults to currentColor)
 * @param props.asChild - If true, render as Radix Slot child
 */
import type * as React from "react";
interface BrandCardProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode;
    className?: string;
    hover?: boolean;
    corners?: boolean;
    cornerSize?: "sm" | "md" | "lg" | "xl";
    cornerColor?: string;
    asChild?: boolean;
}
export declare function BrandCard({ children, className, hover, corners, cornerSize, cornerColor, asChild, ...props }: BrandCardProps): import("react/jsx-runtime").JSX.Element;
interface AgentCardProps {
    title: string;
    description: string;
    icon: React.ReactNode;
    color: string;
    action?: React.ReactNode;
    className?: string;
}
export declare function AgentCard({ title, description, icon, color, action, className, }: AgentCardProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=brand-card.d.ts.map