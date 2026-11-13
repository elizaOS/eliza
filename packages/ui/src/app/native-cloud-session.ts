import type {
  NativeCloudSignInAuthenticated,
  NativeCloudSignInCopy,
  NativeCloudSignInPort,
} from "@elizaos/auth/auth/native-cloud-sign-in";
import type {
  CloudCredits,
  CloudStatus,
} from "../api/client-types-cloud-session.js";

/** A verified account read, independent of resident and inference readiness. */
export interface NativeCloudSessionSnapshot {
  readonly status: CloudStatus;
  readonly credits: CloudCredits | null;
}

/**
 * Native credential storage remains with the installed host. AppProvider owns
 * account presentation and commands; this port never returns a bearer token.
 * Each operation must capture the current credential generation and refuse a
 * result if it changes before completion. A failed read is unavailable, not a
 * signed-out snapshot. Only confirmed absence may return connected:false.
 */
export interface NativeCloudSessionPort {
  readonly environment: "production" | "staging";
  readonly signIn: NativeCloudSignInPort<"production" | "staging">;
  readonly copy: NativeCloudSignInCopy;
  read(signal: AbortSignal): Promise<NativeCloudSessionSnapshot>;
  /** Verify the exact installed credential named by this native completion. */
  activate(
    outcome: NativeCloudSignInAuthenticated<"production" | "staging">,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Remove the current account using the existing native CAS/retirement owner.
   * A stop dispatch is not acknowledgement. Reject if retirement is unconfirmed;
   * the resident can subsequently run without the retired Cloud credential.
   */
  signOut(signal: AbortSignal): Promise<void>;
}
