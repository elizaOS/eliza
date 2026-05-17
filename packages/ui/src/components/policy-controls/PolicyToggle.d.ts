import type React from "react";
/**
 * Collapsible policy card with toggle, summary in header, and expand-on-click.
 */
export declare function PolicyToggle({
  icon: Icon,
  title,
  summary,
  enabled,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{
    className?: string;
  }>;
  title: string;
  summary?: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children?: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=PolicyToggle.d.ts.map
