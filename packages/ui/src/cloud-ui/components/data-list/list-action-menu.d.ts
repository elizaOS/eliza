import type { ComponentType, MouseEvent, ReactNode } from "react";

type ListActionMenuItem =
  | {
      type?: "item";
      key?: string;
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
      key?: string;
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
      key?: string;
    };
interface ListActionMenuProps {
  label?: ReactNode;
  items: readonly ListActionMenuItem[];
  align?: "start" | "center" | "end";
  contentClassName?: string;
  triggerClassName?: string;
  onTriggerClick?: (event: MouseEvent) => void;
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
