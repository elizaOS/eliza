export type { WhatsAppPairingStatus } from "../api/client-types-core";
import type { WhatsAppPairingStatus } from "../api/client-types-core";
export declare function useWhatsAppPairing(accountId?: string): {
    startPairing: () => Promise<void>;
    stopPairing: () => Promise<void>;
    disconnect: () => Promise<void>;
    status: WhatsAppPairingStatus;
    qrDataUrl: string | null;
    phoneNumber: string | null;
    error: string | null;
};
//# sourceMappingURL=useWhatsAppPairing.d.ts.map