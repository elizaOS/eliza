import * as React from "react";
export type ChatPanelLayoutVariant = "full-overlay" | "companion-dock";
export interface ChatPanelLayoutProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: ChatPanelLayoutVariant;
  sidebar?: React.ReactNode;
  mobileSidebar?: React.ReactNode;
  showSidebar?: boolean;
  thread: React.ReactNode;
}
export declare function ChatPanelLayout({
  variant,
  sidebar,
  mobileSidebar,
  showSidebar,
  thread,
  className,
  ...props
}: ChatPanelLayoutProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-panel-layout.d.ts.map
