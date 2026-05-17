import {
  type CloudSetupSessionService,
  type ContainerHandoffEnvelope,
  type SetupExtractedFact,
  type SetupSessionEnvelope,
  type SetupTranscriptMessage,
} from "@elizaos/cloud-sdk/cloud-setup-session";
export type CloudSetupStatus =
  | "idle"
  | "starting"
  | "ready"
  | "provisioning"
  | "handoff"
  | "error";
export interface UseCloudSetupSessionOptions {
  tenantId?: string;
  service?: CloudSetupSessionService;
  /** Poll cadence in ms while the container is provisioning. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Auto-start a session on mount. Defaults to true. */
  autoStart?: boolean;
  /** Called exactly once when the handoff envelope is ready. */
  onHandoff?: (envelope: ContainerHandoffEnvelope) => void;
}
export interface UseCloudSetupSessionResult {
  envelope: SetupSessionEnvelope | null;
  transcript: SetupTranscriptMessage[];
  facts: SetupExtractedFact[];
  status: CloudSetupStatus;
  error: Error | null;
  sendMessage(text: string): Promise<void>;
  cancel(): Promise<void>;
}
export declare function useCloudSetupSession(
  opts?: UseCloudSetupSessionOptions,
): UseCloudSetupSessionResult;
//# sourceMappingURL=cloud-setup.d.ts.map
