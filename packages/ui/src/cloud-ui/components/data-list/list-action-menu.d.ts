import type { ComponentType, ReactNode } from "react";

type ListActionMenuItem =
  | {
      type?: "item";
      label: ReactNode;
      icon?: ComponentType<{
        className?: string;
      }>;
      onSelect?: () => void;
      disabled?: boolean;
      destructive?: boolean;
      className?: string;
      asChild?: false;
    }
  | {
      type?: "item";
      label: ReactNode;
      icon?: ComponentType<{
        className?: string;
      }>;
      disabled?: boolean;
      destructive?: boolean;
      className?: string;
      asChild: true;
      child: ReactNode;
    }
  | {
      type: "separator";
    };
interface ListActionMenuProps {
  label?: ReactNode;
  items: readonly ListActionMenuItem[];
  align?: "start" | "center" | "end";
  contentClassName?: string;
  triggerClassName?: string;
  onTriggerClick?: (event: React.MouseEvent) => void;
}
export declare function ListActionMenu({
  label,
  items,
  align,
  contentClassName,
  triggerClassName,
  onTriggerClick,
}: ListActionMenuProps): import("react/jsx-runtime").JSX.Element;
export type { ListActionMenuItem, ListActionMenuProps };
//# sourceMappingURL=list-action-menu.d.ts.map
