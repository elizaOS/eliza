export type { VoiceCallProvider } from "./base";
export { callContextProvider } from "./callContext";
export { callStateProvider as voiceCallStateProvider } from "./callState";
export { MockProvider } from "./mock";
export { TwilioVoiceProvider, type TwilioVoiceProviderOptions } from "./twilio";

import type { VoiceCallSettings } from "../environment";
import type { VoiceCallProvider } from "./base";
import { MockProvider } from "./mock";
import { TwilioVoiceProvider } from "./twilio";

/**
 * Create a voice call provider based on settings.
 */
export function createProvider(
  settings: VoiceCallSettings,
  options?: { skipVerification?: boolean }
): VoiceCallProvider {
  const providerOptions = { skipVerification: options?.skipVerification };

  switch (settings.provider) {
    case "twilio":
      if (!settings.twilio) {
        throw new Error("Twilio configuration is required");
      }
      return new TwilioVoiceProvider(settings.twilio, {
        ...providerOptions,
        publicUrl: settings.publicUrl,
        streamPath: settings.streaming.streamPath,
      });

    case "mock":
      return new MockProvider();

    default:
      throw new Error(
        `Unknown or unsupported provider: ${settings.provider}. Supported providers: twilio, mock`
      );
  }
}
