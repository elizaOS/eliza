declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    BLOOIO: "blooio";
  }

  interface ServiceClassMap {
    blooio: typeof import("../service").BlooioService;
  }
}

export {};
