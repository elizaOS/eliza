/**
 * Hover-only tooltip with optional shortcut hint. Used as the icon-button
 * affordance pattern in plugins/plugin-companion. The other extended-tooltip
 * primitives (HoverTooltip, Spotlight, useGuidedTour, TourStep) were
 * deleted as zero-consumer in the Layer 5b sweep — their last shipping
 * surface was a guided-tour feature that was never wired up.
 */
export declare function IconTooltip({ children, label, shortcut, position, multiline, }: {
    children: React.ReactNode;
    label: string;
    shortcut?: string;
    position?: "top" | "bottom";
    /** Long labels: wrap and cap width. */
    multiline?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=tooltip-extended.d.ts.map