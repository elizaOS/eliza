/**
 * Types for the persisted agent-profile registry: each profile records how one
 * agent (local, cloud, or remote) is reached and authenticated. Consumed by the
 * agent-profiles store and the runtime-switching flow.
 */
export interface AgentProfile {
  /** Stable unique identifier (UUID v4). */
  id: string;
  /** User-visible name. */
  label: string;
  /** How this agent is hosted. */
  kind: "local" | "cloud" | "remote";
  /** For Cloud: the stable logical identity (for personal Eliza, `personal:*`). */
  cloudAgentId?: string;
  /** Cloud runtime currently serving that identity (Shared id or Dedicated UUID). */
  cloudRuntimeAgentId?: string;
  /** Hosting mode of the current Cloud runtime target. */
  cloudRuntime?: "shared" | "dedicated";
  /** For remote/cloud agents: the reachable API base URL. */
  apiBase?: string;
  /** Auth/access token, if any. */
  accessToken?: string;
  /** Native credential-store lookup key; never a bearer value. */
  credentialRef?: string;
  /** How a remote profile reaches its agent without exposing private transport details. */
  connectionMode?: "direct" | "relay" | "ssh";
  /** Cloud relay authority and target public identity for an E2EE session. */
  remoteRelay?: {
    ownerId: string;
    controllerDeviceId: string;
    controllerKeyId: string;
    grantId: string;
    grantRevision: number;
    sessionId: string;
    targetRuntimeId: string;
    targetKeyId: string;
    targetDisplayName: string;
    targetCreatedAt: number;
    targetPlatform: "macos" | "windows" | "linux" | "ios" | "android" | "web";
    targetSigningPublicKeyJwk: JsonWebKey;
    targetEncryptionPublicKeyJwk: JsonWebKey;
    expiresAt: string | null;
  };
  /** Non-secret SSH connection metadata; credentials stay in the OS/SSH agent. */
  ssh?: {
    target: string;
    sshPort: number;
    remoteApiPort: number;
    hostFingerprint: string;
    identityFile?: string;
  };
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
