import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { DeviceCredential } from "../src/services/device-actions/contract.ts";
import { withDeviceActionTurn } from "../src/services/device-actions/service.ts";

/** Authenticate the owner turn. Production subjects are auth identities, not
 * entity UUIDs: pass `ownerEntityId` to bind a distinct mapped owner entity.
 * Without it the subject doubles as the entity ID. */
export function withOwnerDeviceActionTurn<T>(
  runtime: IAgentRuntime,
  credential: DeviceCredential,
  fn: () => Promise<T>,
  {
    ownerEntityId,
    ...options
  }: NonNullable<Parameters<typeof withDeviceActionTurn>[3]> & {
    ownerEntityId?: UUID;
  } = {},
): Promise<T> {
  return withDeviceActionTurn(runtime, credential, fn, {
    requestCaller: {
      subjectUserId: credential.subjectUserId,
      entityId: ownerEntityId ?? (credential.subjectUserId as UUID),
      role: "OWNER",
    },
    ...options,
  });
}
