import type { CodingAgentSession } from "@elizaos/app-core";
import { PtyConsoleBase } from "./PtyConsoleBase";

interface PtyConsoleDrawerProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
}

export function PtyConsoleDrawer({
  activeSessionId,
  sessions,
  onClose,
}: PtyConsoleDrawerProps) {
  return (
    <div
      className="border-t border-border bg-bg flex flex-col"
      style={{ height: "40vh", minHeight: 180, maxHeight: "60vh" }}
    >
      <PtyConsoleBase
        activeSessionId={activeSessionId}
        sessions={sessions}
        onClose={onClose}
        variant="drawer"
      />
    </div>
  );
}
