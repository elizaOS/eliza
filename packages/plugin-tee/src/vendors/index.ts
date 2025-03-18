import { PhalaVendor } from './phala';
import type { TeeVendor } from './types';
import { type TeeVendorName, TeeVendorNames } from './types';

const vendors: Record<TeeVendorName, TeeVendor> = {
  [TeeVendorNames.PHALA]: new PhalaVendor(),
};

export const getVendor = (type: TeeVendorName): TeeVendor => {
  const vendor = vendors[type];
  if (!vendor) {
    throw new Error(`Unsupported TEE vendor type: ${type}`);
  }
  return vendor;
};

export * from './types';
