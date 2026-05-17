export declare const IOS_FULL_BUN_SMOKE_REQUEST_KEY =
  "eliza:ios-full-bun-smoke:request";
export declare const IOS_FULL_BUN_SMOKE_RESULT_KEY =
  "eliza:ios-full-bun-smoke:result";
declare global {
  interface Window {
    __ELIZA_IOS_LOCAL_AGENT_DEBUG__?: (event: Record<string, unknown>) => void;
  }
}
/**
 * If the host has requested the iOS full-Bun smoke (via localStorage or
 * Capacitor Preferences), boot the in-process Bun runtime and drive the
 * canonical probe sequence. Returns true when the smoke ran (whether it
 * passed or failed) so the caller can short-circuit the normal React boot.
 */
export declare function runIosFullBunSmokeIfRequested(): Promise<boolean>;
//# sourceMappingURL=ios-runtime-bridge.d.ts.map
