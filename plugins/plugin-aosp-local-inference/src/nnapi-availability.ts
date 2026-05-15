/**
 * Probe whether the ORT NNAPI execution provider is wireable on the current
 * Android host.
 *
 * Tracks elizaOS/eliza#7667. This is a readiness scaffold — the initial
 * implementation reports `available: false` with a "not implemented" reason
 * so the future Tensor TPU / NNAPI delegate PR has a single, well-typed
 * surface to flip on. It is intentionally a NEW standalone module: it does
 * not touch `aosp-local-inference-bootstrap.ts` (which is moving as part
 * of #7666) and it does not introduce a runtime dependency on
 * `onnxruntime-react-native`.
 *
 * When a future PR enables this probe, the contract is:
 *   - `available: true` only when the loaded ORT package exposes an
 *     `nnapi` execution provider AND `process.versions.android` / a probed
 *     `Build.VERSION.SDK_INT` indicates API 27+.
 *   - Otherwise return `available: false` with an actionable `reason`
 *     describing what's missing (build flag, API level, hardware).
 *
 * Callers in the AOSP plugin's local-inference bootstrap (post-#7666)
 * should treat `available: false` as a fall-through to the CPU EP,
 * matching the `DEFAULT_KOKORO_EXECUTION_PROVIDER = "cpu"` default in
 * `@elizaos/shared/local-inference`.
 */

export type NnapiUnavailableReason =
  | "not implemented"
  | "ort build lacks nnapi ep"
  | "android api below 27"
  | "not android"
  | "probe error";

export interface NnapiAvailability {
  available: boolean;
  /**
   * Human-readable explanation. Present whether `available` is true or
   * false so callers can surface it in diagnostics without conditional
   * formatting.
   */
  reason: NnapiUnavailableReason | "available";
  /**
   * Android API level the probe observed. `null` when the host is not
   * Android or the level could not be determined.
   */
  androidApiLevel: number | null;
}

/**
 * Initial readiness-scaffold implementation. Returns the documented
 * stub-shape so consumers and tests can wire against the final contract
 * before the NNAPI delegate is built.
 *
 * The future implementation will:
 *   1. Confirm we're running on AOSP (probe `process.versions.android` or
 *      a native bridge that reads `Build.VERSION.SDK_INT`).
 *   2. Dynamically import the ORT package the platform ships and check
 *      whether `nnapi` appears in its advertised execution-provider list.
 *   3. Report API level so the caller can gate on >= 27.
 *
 * Do not add ORT as a dependency from this module — keep the probe pure
 * until the wiring PR lands.
 */
export async function probeNnapiAvailability(): Promise<NnapiAvailability> {
  return {
    available: false,
    reason: "not implemented",
    androidApiLevel: null,
  };
}
