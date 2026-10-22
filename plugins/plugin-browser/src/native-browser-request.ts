import type { Memory } from "@elizaos/core";
import { asObjectRecord as asRecord } from "@elizaos/core/protocol";

/** Whether the message came from a client's own native Browser page. */
export function isNativeBrowserRequest(message: Memory): boolean {
  return asRecord(message.content.metadata)?.uiBrowserSurface === "native";
}
