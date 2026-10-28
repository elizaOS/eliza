import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { DeviceCredential } from "../src/services/device-actions/contract.ts";
import { withDeviceActionTurn } from "../src/services/device-actions/service.ts";

/** These fixtures authenticate the owner with the same subject and entity ID. */
export function withOwnerDeviceActionTurn<T>(
  runtime: IAgentRuntime,
  credential: DeviceCredential,
  fn: () => Promise<T>,
  options: NonNullable<Parameters<typeof withDeviceActionTurn>[3]> = {},
): Promise<T> {
  return withDeviceActionTurn(runtime, credential, fn, {
    requestCaller: {
      subjectUserId: credential.subjectUserId,
      entityId: credential.subjectUserId as UUID,
      role: "OWNER",
    },
    ...options,
  });
}
