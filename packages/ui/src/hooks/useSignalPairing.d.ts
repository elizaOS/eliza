export type { SignalPairingStatus } from "../api/client-types-core";
import type { SignalPairingStatus } from "../api/client-types-core";
export declare function useSignalPairing(accountId?: string): {
    startPairing: () => Promise<void>;
    stopPairing: () => Promise<void>;
    disconnect: () => Promise<void>;
    status: SignalPairingStatus;
    qrDataUrl: string | null;
    phoneNumber: string | null;
    error: string | null;
};
//# sourceMappingURL=useSignalPairing.d.ts.map