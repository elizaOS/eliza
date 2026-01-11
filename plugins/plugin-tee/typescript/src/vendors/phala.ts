/**
 * Phala Network TEE Vendor implementation.
 */

import type { Action, Provider } from "@elizaos/core";
import { remoteAttestationAction } from "../actions/remoteAttestation";
import { phalaDeriveKeyProvider, phalaRemoteAttestationProvider } from "../providers";
import { type TeeVendorInterface, TeeVendorNames } from "./types";

/**
 * Phala Network TEE Vendor.
 *
 * Provides TEE capabilities using Phala Network's DStack SDK.
 */
export class PhalaVendor implements TeeVendorInterface {
  readonly type = TeeVendorNames.PHALA;

  /**
   * Get actions provided by Phala vendor.
   */
  getActions(): Action[] {
    return [remoteAttestationAction];
  }

  /**
   * Get providers provided by Phala vendor.
   */
  getProviders(): Provider[] {
    return [phalaDeriveKeyProvider, phalaRemoteAttestationProvider];
  }

  /**
   * Get the vendor name.
   */
  getName(): string {
    return "phala-tee-plugin";
  }

  /**
   * Get the vendor description.
   */
  getDescription(): string {
    return "Phala Network TEE for secure agent execution";
  }
}


