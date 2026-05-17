interface PageTransitionProps {
    children: React.ReactNode;
    className?: string;
    variant?: "fade" | "slide" | "scale";
    /** Key used to trigger the transition (typically the current pathname) */
    pathname?: string;
}
export declare function PageTransition({ children, className, variant, pathname, }: PageTransitionProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=page-transition.d.ts.map