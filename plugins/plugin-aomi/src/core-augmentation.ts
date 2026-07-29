/** Registers the Aomi service key with the core runtime's service type registry. */

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    AOMI: "aomi";
  }
}

export {};
