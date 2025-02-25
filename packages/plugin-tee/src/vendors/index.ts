import type { TeeVendor } from './types';
import { PhalaVendor } from './phala';
import { GramineVendor } from './gramine';
import { MarlinVendor } from './marlin';
import { FleekVendor } from './fleek';
import { TeeVendorNames, TeeVendorName } from './types';

const vendors: Record<TeeVendorName, TeeVendor> = {
    [TeeVendorNames.PHALA]: new PhalaVendor(),
    [TeeVendorNames.MARLIN]: new MarlinVendor(),
    [TeeVendorNames.FLEEK]: new FleekVendor(),
    [TeeVendorNames.SGX_GRAMINE]: new GramineVendor(),
};

export const getVendor = (type: TeeVendorName): TeeVendor => {
    const vendor = vendors[type];
    if (!vendor) {
        throw new Error(`Unsupported TEE vendor type: ${type}`);
    }
    return vendor;
};

export * from './types';
