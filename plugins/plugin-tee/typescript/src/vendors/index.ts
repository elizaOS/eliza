/**
 * TEE Vendor registry and exports.
 */

import { PhalaVendor } from "./phala";
import { type TeeVendorInterface, type TeeVendorName, TeeVendorNames } from "./types";

/**
 * Registered vendors.
 */
const vendors: Record<TeeVendorName, TeeVendorInterface> = {
  [TeeVendorNames.PHALA]: new PhalaVendor(),
};

/**
 * Get a vendor by name.
 *
 * @param type - The vendor type name.
 * @returns The vendor implementation.
 * @throws Error if vendor is not supported.
 */
export function getVendor(type: TeeVendorName): TeeVendorInterface {
  const vendor = vendors[type];
  if (!vendor) {
    throw new Error(`Unsupported TEE vendor: ${type}`);
  }
  return vendor;
}

export { PhalaVendor } from "./phala";
