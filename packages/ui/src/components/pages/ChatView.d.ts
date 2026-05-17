import { type CodingAgentSession } from "../../api/client";

export { __resetCompanionSpeechMemoryForTests } from "./chat-view-hooks";

type ChatViewVariant = "default" | "game-modal";
interface ChatViewProps {
  variant?: ChatViewVariant;
  /** Override click handler for agent activity box sessions. */
  onPtySessionClick?: (sessionId: string) => void;
}
export declare function ChatView({
  variant,
  onPtySessionClick,
}: ChatViewProps): import("react/jsx-runtime").JSX.Element;
/**
 * Full-window terminal view rendered when the Terminal channel is
 * active. Keeps every PTY session pane mounted under the hood so
 * tabbing between sessions preserves their buffers/state. Spawning is
 * owned by the sidebar — this component only displays what the
 * orchestrator has already registered, and waits for the live session
 * list to catch up when activeSessionId is set but not yet present.
 */
export declare function TerminalChannelPanel({
  activeSessionId,
  sessions,
  onClose,
  loadingLabel,
}: {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
  loadingLabel: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ChatView.d.ts.map
