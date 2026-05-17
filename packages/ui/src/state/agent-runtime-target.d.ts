import { type MobileRuntimeMode } from "../onboarding/mobile-runtime-mode";
import type { PersistedActiveServer } from "./persistence";
export type AgentRuntimeTargetKind = "local" | "cloud" | "remote";
export interface AgentRuntimeTarget {
    kind: AgentRuntimeTargetKind;
    label: string;
}
export declare function isLocalAgentApiBase(value: string | null | undefined): boolean;
export declare function inferAgentRuntimeTarget(args: {
    activeServer: PersistedActiveServer | null;
    mobileRuntimeMode: MobileRuntimeMode | null;
    clientBaseUrl?: string | null;
}): AgentRuntimeTarget;
//# sourceMappingURL=agent-runtime-target.d.ts.map