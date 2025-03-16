import type { Action, Provider } from '@elizaos/core';

export const TeeVendorNames = {
  PHALA: 'phala',
  SGX_GRAMINE: 'sgx_gramine',
} as const;

/**
 * Type representing the name of a Tee vendor.
 * It can either be one of the keys of TeeVendorNames or a string.
 */
export type TeeVendorName = (typeof TeeVendorNames)[keyof typeof TeeVendorNames] | string;

/**
 * Interface for a TeeVendor, representing a vendor that sells tees.
 * @interface
 */

export interface TeeVendor {
  type: TeeVendorName;
  getActions(): Action[];
  getProviders(): Provider[];
  getName(): string;
  getDescription(): string;
}
