import { cn } from "../lib/utils";

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

export function ProductSwitcher({
  items,
  className,
  linkClassName,
  activeClassName,
  inactiveClassName,
  "aria-label": ariaLabel = "Product switcher",
}: ProductSwitcherProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "flex flex-wrap items-center justify-end gap-1 rounded-full border border-border/70 bg-card/82 p-1 text-sm text-muted-strong shadow-sm backdrop-blur-md",
        className,
      )}
    >
      {items.map((item) => (
        <a
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "rounded-full px-3 py-1.5 font-medium transition-colors",
            item.active
              ? "bg-primary text-primary-foreground shadow-sm"
              : "hover:bg-bg-accent hover:text-txt",
            item.active ? activeClassName : inactiveClassName,
            linkClassName,
          )}
          href={item.href}
          key={item.label}
          rel={item.external ? "noopener noreferrer" : undefined}
          target={item.external ? "_blank" : undefined}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
