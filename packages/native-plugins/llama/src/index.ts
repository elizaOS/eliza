/**
 * @elizaos/capacitor-llama
 *
 * Thin adapter that maps `llama-cpp-capacitor`'s contextId-based API onto
 * Eliza's `LocalInferenceLoader` contract. At most one native context lives
 * at a time; switching models disposes the previous context first so we
 * never double-allocate VRAM.
 *
 * On web this package falls back to an "unavailable" stub. Mobile builds
 * should call `registerCapacitorLlamaLoader(runtime)` during bootstrap to
 * wire this adapter in as the runtime's `localInferenceLoader` service.
 */

export {
  capacitorLlama,
  registerCapacitorLlamaLoader,
} from "./capacitor-llama-adapter";
export * from "./definitions";
export {
  DeviceBridgeClient,
  type DeviceBridgeClientConfig,
  startDeviceBridgeClient,
} from "./device-bridge-client";
