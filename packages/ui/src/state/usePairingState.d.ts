/**
 * Pairing / auth state — extracted from AppContext.
 *
 * Manages the pairing code UI (input, submit, error, busy). The startup
 * effect sets pairingEnabled/pairingExpiresAt from the backend — those
 * setters are returned so AppContext can wire them.
 */
export declare function persistPairedToken(token: string): void;
export declare function usePairingState(): {
  state: {
    pairingEnabled: boolean;
    pairingExpiresAt: number | null;
    pairingCodeInput: string;
    pairingError: string | null;
    pairingBusy: boolean;
  };
  setPairingEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setPairingExpiresAt: import("react").Dispatch<
    import("react").SetStateAction<number | null>
  >;
  setPairingCodeInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  handlePairingSubmit: () => Promise<void>;
};
//# sourceMappingURL=usePairingState.d.ts.map
