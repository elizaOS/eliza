/**
 * Multi-agent profile registry.
 *
 * Stores a catalogue of known agent connections (local, cloud, remote) in
 * localStorage so users can manage and switch between multiple agents.
 */
import type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";
export type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";
export declare function loadAgentProfileRegistry(): AgentProfileRegistry;
export declare function saveAgentProfileRegistry(registry: AgentProfileRegistry): void;
export declare function getActiveProfile(): AgentProfile | null;
export declare function setActiveProfileId(id: string): void;
export declare function addAgentProfile(profile: Omit<AgentProfile, "id" | "createdAt">): AgentProfile;
export declare function removeAgentProfile(id: string): void;
export declare function updateAgentProfile(id: string, updates: Partial<Omit<AgentProfile, "id" | "createdAt">>): void;
//# sourceMappingURL=agent-profiles.d.ts.map