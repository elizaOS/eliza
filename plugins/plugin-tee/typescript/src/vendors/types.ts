/**
 * TEE Vendor types and interfaces.
 */

import type { Action, Provider } from "@elizaos/core";

/**
 * Supported TEE vendor names.
 */
export const TeeVendorNames = {
  /** Phala Network */
  PHALA: "phala",
} as const;

/**
 * Type for vendor name values.
 */
export type TeeVendorName = (typeof TeeVendorNames)[keyof typeof TeeVendorNames];

/**
 * Interface for a TEE vendor implementation.
 */
export interface TeeVendorInterface {
  /** The vendor type */
  readonly type: TeeVendorName;

  /** Get actions provided by this vendor */
  getActions(): Action[];

  /** Get providers provided by this vendor */
  getProviders(): Provider[];

  /** Get the vendor name */
  getName(): string;

  /** Get the vendor description */
  getDescription(): string;
}
