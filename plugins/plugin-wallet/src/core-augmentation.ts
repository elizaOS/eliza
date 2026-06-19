/**
 * Augment elizaOS service registry so `getService("wallet-backend")` is typed.
 */
declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    WALLET_BACKEND: "wallet-backend";
  }
}

export {};
