/**
 * Worker RPC HMAC envelope (SOC2 A-4).
 *
 * Both sides agree on a canonical byte sequence over which the MAC is
 * computed. The host mints the per-install key via KMS
 * (`system:plugin-rpc-hmac-<sanitized-plugin-id>/v1`) and provides it to
 * the worker at bootstrap. Each `WorkerRpcMessage` carries `mac`; the
 * dispatcher verifies before invoking any surface.
 */
import type { KeyId } from "@elizaos/security";
import type { WorkerRpcMessage } from "./types.js";
/** Canonical bytes covered by the MAC. */
export declare function canonicalRpcBytes(
  message: Pick<WorkerRpcMessage, "requestId" | "surface" | "target" | "args">,
): Uint8Array;
/**
 * KMS keyId for a plugin's per-install RPC HMAC key. The plugin id is
 * sanitized to fit the KMS purpose grammar.
 */
export declare function pluginRpcKeyId(pluginId: string): KeyId;
export declare function hexEncode(bytes: Uint8Array): string;
export declare function hexDecode(hex: string): Uint8Array;
//# sourceMappingURL=rpc-mac.d.ts.map
