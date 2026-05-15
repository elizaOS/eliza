import type { CodingAgentSession } from "@elizaos/ui/api/client-types-cloud";
import { PtyConsoleBase } from "./PtyConsoleBase";

export interface PtyConsoleSidePanelProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
}

export function PtyConsoleSidePanel(props: PtyConsoleSidePanelProps) {
  return <PtyConsoleBase {...props} variant="side-panel" />;
}
