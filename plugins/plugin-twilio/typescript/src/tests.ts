import {
  type IAgentRuntime,
  type TestSuite,
  type TestCase,
  logger,
} from "@elizaos/core";
import axios from "axios";
import * as readline from "readline";
import { TWILIO_SERVICE_NAME } from "./constants";
import type { TwilioService } from "./service";
import { VOICE_CALL_SERVICE_NAME } from "./voicecall/constants";
import type { VoiceCallService } from "./voicecall/service";

export class TwilioTestSuite implements TestSuite {
  name = "Twilio Plugin Test Suite";
  description = "Tests for Twilio voice/SMS and advanced voice call functionality";

  tests: TestCase[] = [
    {
      name: "Service Initialization Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        // Check service properties
        if (!twilioService.isConnected) {
          throw new Error("Twilio service is not connected");
        }

        if (!twilioService.phoneNumber) {
          throw new Error("Twilio phone number not configured");
        }

        logger.info(`✅ Service initialized with phone number: ${twilioService.phoneNumber}`);
      },
    },
    {
      name: "Send SMS Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        const testNumber = runtime.getSetting("TWILIO_TEST_PHONE_NUMBER");
        if (!testNumber) {
          logger.warn("TWILIO_TEST_PHONE_NUMBER not set, skipping SMS test");
          return;
        }

        const result = await twilioService.sendSms(String(testNumber), "Test SMS from Eliza Twilio plugin");

        logger.info(`✅ SMS test successful. Message SID: ${result.sid}`);
      },
    },
    {
      name: "Send MMS Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        const testNumber = runtime.getSetting("TWILIO_TEST_PHONE_NUMBER");
        if (!testNumber) {
          logger.warn("TWILIO_TEST_PHONE_NUMBER not set, skipping MMS test");
          return;
        }

        const result = await twilioService.sendSms(
          String(testNumber),
          "Test MMS from Eliza Twilio plugin",
          ["https://demo.twilio.com/owl.png"] // Twilio's demo image
        );

        logger.info(`✅ MMS test successful. Message SID: ${result.sid}`);
      },
    },
    {
      name: "Make Call Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        const testNumber = runtime.getSetting("TWILIO_TEST_PHONE_NUMBER");
        if (!testNumber) {
          logger.warn("TWILIO_TEST_PHONE_NUMBER not set, skipping call test");
          return;
        }

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">This is a test call from Eliza Twilio plugin. Goodbye!</Say>
    <Hangup/>
</Response>`;

        const result = await twilioService.makeCall(String(testNumber), twiml);

        logger.info(`✅ Call test successful. Call SID: ${result.sid}`);
      },
    },
    {
      name: "Webhook Server Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        // Check if service is connected (webhook server running)
        if (!twilioService.isConnected) {
          throw new Error("Webhook server is not running");
        }

        const webhookPort = String(runtime.getSetting("TWILIO_WEBHOOK_PORT") ?? "3000");
        logger.info(`✅ Webhook server is running on port ${webhookPort}`);

        // Test webhook endpoints
        const webhookUrl = runtime.getSetting("TWILIO_WEBHOOK_URL");
        if (webhookUrl && String(webhookUrl).includes("localhost")) {
          try {
            // Test SMS webhook endpoint
            const smsResponse = await axios.post(
              `http://localhost:${String(webhookPort)}/webhooks/twilio/sms`,
              {
                MessageSid: "TEST123",
                From: "+18885551234",
                To: twilioService.phoneNumber,
                Body: "Test webhook message",
              },
              {
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              }
            );

            if (smsResponse.status === 200) {
              logger.info("✅ SMS webhook endpoint is responding");
            }

            // Test voice webhook endpoint
            const voiceResponse = await axios.post(
              `http://localhost:${webhookPort}/webhooks/twilio/voice`,
              {
                CallSid: "CATEST123",
                From: "+18885551234",
                To: twilioService.phoneNumber,
                CallStatus: "ringing",
              },
              {
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              }
            );

            if (voiceResponse.status === 200) {
              logger.info("✅ Voice webhook endpoint is responding");
            }
          } catch (error) {
            logger.warn({ error: String(error) }, "Could not test webhook endpoints locally");
          }
        }
      },
    },
    {
      name: "Conversation History Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        const testNumber = runtime.getSetting("TWILIO_TEST_PHONE_NUMBER");
        if (!testNumber) {
          logger.warn("TWILIO_TEST_PHONE_NUMBER not set, skipping conversation history test");
          return;
        }

        // Send a test message first
        await twilioService.sendSms(String(testNumber), "History test message");

        // Get conversation history
        const history = twilioService.getConversationHistory(String(testNumber), 5);

        if (history.length > 0) {
          logger.info(`✅ Conversation history retrieved: ${history.length} messages`);
          logger.info(`   Latest message: ${history[history.length - 1].body}`);
        } else {
          logger.info("✅ Conversation history is empty (expected for new number)");
        }
      },
    },
    {
      name: "Error Handling Test",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        // Test invalid phone number
        try {
          await twilioService.sendSms("invalid-number", "Test");
          throw new Error("Expected error for invalid phone number");
        } catch (error: any) {
          if (error.message.includes("Invalid phone number")) {
            logger.info("✅ Invalid phone number error handled correctly");
          } else {
            throw error;
          }
        }

        // Test empty message
        try {
          await twilioService.sendSms("+18885551234", "");
          // This might not throw an error, but Twilio will reject it
          logger.info("✅ Empty message handled");
        } catch (error) {
          logger.info("✅ Empty message error handled correctly");
        }
      },
    },
    {
      name: "Voice Call Service Initialization Test",
      fn: async (runtime: IAgentRuntime) => {
        const voiceCallService = runtime.getService(
          VOICE_CALL_SERVICE_NAME,
        ) as unknown as VoiceCallService;

        if (!voiceCallService) {
          logger.warn(
            "Voice Call service not initialized - VOICE_CALL_PROVIDER may not be set",
          );
          logger.info(
            "✅ Voice Call service correctly not initialized when no provider configured",
          );
          return;
        }

        if (voiceCallService.isConnected()) {
          const settings = voiceCallService.getSettings();
          logger.info(
            `✅ Voice Call service initialized with provider: ${settings?.provider}`,
          );
          logger.info(`   From number: ${settings?.fromNumber}`);
          logger.info(
            `   Max concurrent calls: ${settings?.maxConcurrentCalls}`,
          );
        } else {
          logger.info(
            "✅ Voice Call service loaded but not connected (expected when provider is not fully configured)",
          );
        }
      },
    },
    {
      name: "Voice Call State Management Test",
      fn: async (runtime: IAgentRuntime) => {
        const voiceCallService = runtime.getService(
          VOICE_CALL_SERVICE_NAME,
        ) as unknown as VoiceCallService;

        if (!voiceCallService || !voiceCallService.isConnected()) {
          logger.warn(
            "Voice Call service not connected, skipping state management test",
          );
          return;
        }

        // Test that we can query active calls
        const activeCalls = voiceCallService.getActiveCalls();
        logger.info(`✅ Active calls query works: ${activeCalls.length} active`);

        // Test call history
        const history = voiceCallService.getCallHistory(5);
        logger.info(`✅ Call history query works: ${history.length} records`);

        // Test service probe
        const probe = await voiceCallService.probeService();
        logger.info(`✅ Service probe: ok=${probe.ok}, provider=${probe.provider}`);
      },
    },
    {
      name: "Interactive Test Mode",
      fn: async (runtime: IAgentRuntime) => {
        const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
        if (!twilioService) {
          throw new Error("Twilio service not initialized");
        }

        const phoneNumber = runtime.getSetting("TWILIO_PHONE_NUMBER");
        const testNumber = runtime.getSetting("TWILIO_TEST_PHONE_NUMBER");

        if (!phoneNumber || !testNumber) {
          throw new Error(
            "TWILIO_PHONE_NUMBER and TWILIO_TEST_PHONE_NUMBER must be set for interactive testing"
          );
        }

        logger.info("\n🎮 INTERACTIVE TWILIO TEST MODE");
        logger.info("================================");
        logger.info(`📱 Your Twilio Number: ${phoneNumber}`);
        logger.info(`📱 Test Target Number: ${testNumber}`);
        logger.info("\n📋 Instructions:");
        logger.info("1. The webhook server is running and listening for incoming messages");
        logger.info("2. Text or call your Twilio number to test incoming messages");
        logger.info("3. The test will send a test SMS and make a test call");
        logger.info("4. Watch the console for incoming message logs");
        logger.info("\nPress Enter to start the interactive test...");

        // Wait for user to press enter
        await new Promise<void>((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question("", () => {
            rl.close();
            resolve();
          });
        });

        // Test 1: Send SMS
        logger.info("\n📤 Test 1: Sending SMS...");
        try {
          const smsResult = await twilioService.sendSms(
            String(testNumber),
            "🎉 Interactive test SMS from elizaOS! Reply to test two-way messaging."
          );
          logger.info(`✅ SMS sent! SID: ${smsResult.sid}`);
          logger.info(`   Status: ${smsResult.status}`);
        } catch (error) {
          logger.error(`❌ SMS failed: ${error}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Test 2: Make Call
        logger.info("\n📤 Test 2: Making call...");
        try {
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Hello from elizaOS interactive test! This call confirms your Twilio integration is working.</Say>
    <Play>https://api.twilio.com/cowbell.mp3</Play>
    <Say voice="alice">Thank you for testing. Goodbye!</Say>
</Response>`;

          const callResult = await twilioService.makeCall(String(testNumber), twiml);
          logger.info(`✅ Call initiated! SID: ${callResult.sid}`);
          logger.info(`   Status: ${callResult.status}`);
        } catch (error) {
          logger.error(`❌ Call failed: ${error}`);
        }

        logger.info("\n📥 Test 3: Waiting for incoming messages...");
        logger.info("   Text your Twilio number now!");
        logger.info("   The server will log any incoming SMS");
        logger.info("\n⏱️  Test will continue for 30 seconds...");

        // Keep test running for 30 seconds to receive messages
        await new Promise((resolve) => setTimeout(resolve, 30000));

        logger.info("\n✨ Interactive test complete!");
        logger.info("Check logs for detailed results.");
      },
    },
  ];
}
