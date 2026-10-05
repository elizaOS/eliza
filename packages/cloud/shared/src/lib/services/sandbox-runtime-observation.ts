/** Defines exact, read-only provider observations used to reconcile a prepared stop without targeting a replacement runtime. */
import { z } from "zod";

export const runtimeIdentitySchema = z
  .object({
    organizationId: z.uuid(),
    agentId: z.uuid(),
    nodeId: z.string().min(1),
    nodeRecordId: z.uuid(),
    nodeIncarnation: z.uuid(),
    nodeHistoryId: z.uuid(),
    hostname: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535),
    sshUser: z.string().min(1),
    hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/),
    containerName: z.string().min(1),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SandboxRuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export interface SandboxRuntimeObservationRequest {
  organizationId: string;
  agentId: string;
  nodeId: string;
  containerName: string;
  expected?: SandboxRuntimeIdentity;
}
export type SandboxRuntimeObservation =
  | { kind: "present"; identity: SandboxRuntimeIdentity; running: boolean }
  | { kind: "absent"; identity: SandboxRuntimeIdentity }
  | { kind: "unavailable"; reason: string };
