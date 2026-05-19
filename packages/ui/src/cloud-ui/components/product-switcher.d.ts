export type ProductSwitcherItem = {
    label: string;
    href: string;
    active?: boolean;
    external?: boolean;
};
export type ProductSwitcherProps = {
    items: ProductSwitcherItem[];
    className?: string;
    linkClassName?: string;
    activeClassName?: string;
    inactiveClassName?: string;
    "aria-label"?: string;
};
export declare function ProductSwitcher({ items, className, linkClassName, activeClassName, inactiveClassName, "aria-label": ariaLabel, }: ProductSwitcherProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=product-switcher.d.ts.map