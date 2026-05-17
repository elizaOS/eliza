import type { CodingAgentSession } from "../../api/client-types-cloud";
interface AgentActivityBoxProps {
    sessions: CodingAgentSession[];
    onSessionClick?: (sessionId: string) => void;
}
export declare function AgentActivityBox({ sessions, onSessionClick, }: AgentActivityBoxProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=AgentActivityBox.d.ts.map