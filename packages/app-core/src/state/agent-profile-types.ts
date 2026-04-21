export interface AgentProfile {
  /** Stable unique identifier (UUID v4). */
  id: string;
  /** User-visible name. */
  label: string;
  /** How this agent is hosted. */
  kind: "local" | "cloud" | "remote";
  /** For cloud agents: the Eliza Cloud agent ID. */
  cloudAgentId?: string;
  /** For remote/cloud agents: the reachable API base URL. */
  apiBase?: string;
  /** Auth/access token, if any. */
  accessToken?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of last successful connection. */
  lastConnectedAt?: string;
  /** State-directory suffix for local agents (e.g. "agents/<id>"). */
  stateDirSuffix?: string;
}

export interface AgentProfileRegistry {
  /** Schema version for future migration. */
  version: 1;
  /** Currently active profile ID (null = none selected). */
  activeProfileId: string | null;
  /** All known profiles. */
  profiles: AgentProfile[];
}
