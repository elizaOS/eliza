declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    TWILIO: "twilio";
  }

  interface ServiceClassMap {
    twilio: typeof import("../service").TwilioService;
  }
}

export {};
