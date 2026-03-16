declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    TWILIO: "twilio";
    VOICE_CALL: "voice-call";
  }

  interface ServiceClassMap {
    twilio: typeof import("../service").TwilioService;
    "voice-call": typeof import("../voicecall/service").VoiceCallService;
  }
}

export {};
