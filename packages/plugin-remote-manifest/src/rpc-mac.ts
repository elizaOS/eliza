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
import { systemKey } from "@elizaos/security";
import type { JsonValue, WorkerRpcMessage } from "./types.js";

/** Stable JSON: sort object keys recursively for deterministic encoding. */
function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("RPC MAC args must contain only finite numbers.");
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, JsonValue>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k] as JsonValue)}`)
    .join(",")}}`;
}

/** Canonical bytes covered by the MAC. */
export function canonicalRpcBytes(
  message: Pick<WorkerRpcMessage, "requestId" | "surface" | "target" | "args">,
): Uint8Array {
  const text = `${message.requestId}\n${message.surface}\n${message.target}\n${stableStringify(message.args ?? null)}`;
  return new TextEncoder().encode(text);
}

/**
 * KMS keyId for a plugin's per-install RPC HMAC key. The plugin id is
 * sanitized to fit the KMS purpose grammar.
 */
export function pluginRpcKeyId(pluginId: string): KeyId {
  const safe = pluginId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe.length === 0) {
    throw new Error(
      "Remote plugin id must contain at least one letter or digit.",
    );
  }
  return systemKey(`plugin-rpc-${safe}`);
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexDecode(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`malformed hex mac: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
