import type { CodingAgentSession } from "@elizaos/ui/api/client-types-cloud";
import { useApp } from "@elizaos/ui";
import { Z_OVERLAY } from "@elizaos/ui";
import { PtyConsoleBase } from "./PtyConsoleBase";

export interface PtyConsoleSidePanelProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
}

export function PtyConsoleSidePanel({
  activeSessionId,
  sessions,
  onClose,
}: PtyConsoleSidePanelProps) {
  const { t } = useApp();
  return (
    <div
      className={`fixed top-0 right-0 bottom-0 z-[${Z_OVERLAY}] flex flex-col bg-bg border-l border-border shadow-2xl`}
      style={{ width: "min(480px, 40vw)" }}
      role="dialog"
      aria-label={t("ptyconsolebase.AgentConsoles", {
        defaultValue: "Agent Consoles",
      })}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <PtyConsoleBase
        activeSessionId={activeSessionId}
        sessions={sessions}
        onClose={onClose}
        variant="side-panel"
      />
    </div>
  );
}
