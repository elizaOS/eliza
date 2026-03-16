// Module augmentation: add COMPUTERUSE to the core service registry so
// `runtime.getServiceLoadPromise("computeruse")` is type-safe.
declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    COMPUTERUSE: "computeruse";
  }
}

export const COMPUTERUSE_SERVICE_TYPE = "computeruse" as const;
