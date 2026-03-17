import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import makeCallAction from "./actions/makeCall";
import sendMmsAction from "./actions/sendMms";
import sendSmsAction from "./actions/sendSms";
import callStateProvider from "./providers/callState";
import conversationHistoryProvider from "./providers/conversationHistory";
import { TwilioService } from "./service";
import { TwilioTestSuite } from "./tests";
import { voiceCallActions, voiceCallProviders, voiceCallServiceClass } from "./voicecall";

// Re-export voice call module for direct imports
export * from "./voicecall";

const twilioPlugin: Plugin = {
  name: "twilio",
  description:
    "Twilio plugin for bidirectional voice and text messaging integration with advanced voice call lifecycle management",
  services: [TwilioService, voiceCallServiceClass],
  actions: [sendSmsAction, makeCallAction, sendMmsAction, ...voiceCallActions],
  providers: [conversationHistoryProvider, callStateProvider, ...voiceCallProviders],
  tests: [new TwilioTestSuite()],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    const accountSid = runtime.getSetting("TWILIO_ACCOUNT_SID") as string;
    const authToken = runtime.getSetting("TWILIO_AUTH_TOKEN") as string;
    const phoneNumber = runtime.getSetting("TWILIO_PHONE_NUMBER") as string;
    const webhookUrl = runtime.getSetting("TWILIO_WEBHOOK_URL") as string;

    if (!accountSid || accountSid.trim() === "") {
      logger.warn(
        "Twilio Account SID not provided - Twilio plugin is loaded but will not be functional"
      );
      logger.warn(
        "To enable Twilio functionality, please provide TWILIO_ACCOUNT_SID in your .env file"
      );
      return;
    }

    if (!authToken || authToken.trim() === "") {
      logger.warn(
        "Twilio Auth Token not provided - Twilio plugin is loaded but will not be functional"
      );
      logger.warn(
        "To enable Twilio functionality, please provide TWILIO_AUTH_TOKEN in your .env file"
      );
      return;
    }

    if (!phoneNumber || phoneNumber.trim() === "") {
      logger.warn(
        "Twilio Phone Number not provided - Twilio plugin is loaded but will not be functional"
      );
      logger.warn(
        "To enable Twilio functionality, please provide TWILIO_PHONE_NUMBER in your .env file"
      );
      return;
    }

    if (!webhookUrl || webhookUrl.trim() === "") {
      logger.warn(
        "Twilio Webhook URL not provided - Twilio will not be able to receive incoming messages or calls"
      );
      logger.warn(
        "To enable incoming communication, please provide TWILIO_WEBHOOK_URL in your .env file"
      );
    }

    // Check for voice call provider configuration
    const voiceCallProvider = config.VOICE_CALL_PROVIDER || process.env.VOICE_CALL_PROVIDER;
    const voiceCallEnabled =
      config.VOICE_CALL_ENABLED !== "false" && process.env.VOICE_CALL_ENABLED !== "false";

    if (voiceCallEnabled && voiceCallProvider) {
      logger.info(`[twilio] Voice call module initializing with provider: ${voiceCallProvider}`);
    }

    logger.info("Twilio plugin initialized successfully");
  },
};

export default twilioPlugin;
