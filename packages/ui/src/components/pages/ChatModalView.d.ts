import "../chat/chat-source-registration.js";
type ChatModalLayoutVariant = "full-overlay" | "companion-dock";
interface ChatModalViewProps {
  variant?: ChatModalLayoutVariant;
  onRequestClose?: () => void;
  showSidebar?: boolean;
  onSidebarClose?: () => void;
  /** Override click handler for agent activity box sessions (e.g. open side panel in companion). */
  onPtySessionClick?: (sessionId: string) => void;
}
export declare const ChatModalView: import("react").MemoExoticComponent<
  ({
    variant,
    showSidebar,
    onSidebarClose,
    onPtySessionClick,
  }: ChatModalViewProps) => import("react/jsx-runtime").JSX.Element
>;
//# sourceMappingURL=ChatModalView.d.ts.map
