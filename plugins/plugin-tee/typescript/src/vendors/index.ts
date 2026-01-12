import { PhalaVendor } from "./phala";
import { type TeeVendorInterface, type TeeVendorName, TeeVendorNames } from "./types";

const vendors: Record<TeeVendorName, TeeVendorInterface> = {
  [TeeVendorNames.PHALA]: new PhalaVendor(),
};

export function getVendor(type: TeeVendorName): TeeVendorInterface {
  const vendor = vendors[type];
  if (!vendor) {
    throw new Error(`Unsupported TEE vendor: ${type}`);
  }
  return vendor;
}

export { PhalaVendor } from "./phala";
export { type TeeVendorInterface, type TeeVendorName, TeeVendorNames } from "./types";
