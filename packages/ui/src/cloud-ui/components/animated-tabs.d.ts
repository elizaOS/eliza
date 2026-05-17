interface Tab {
  value: string;
  label: string;
}
interface AnimatedTabsProps {
  tabs: Tab[];
  value: string;
  onValueChange: (value: string) => void;
  variant?: "default" | "orange";
  fullWidth?: boolean;
}
export declare function AnimatedTabs({
  tabs,
  value,
  onValueChange,
  variant,
  fullWidth,
}: AnimatedTabsProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=animated-tabs.d.ts.map
