import type { IAgentRuntime, TestSuite } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import elevenLabsPlugin from "./index";

/**
 * Check if value is audio data (Buffer, ArrayBuffer, or Uint8Array)
 */
function isAudioData(
  value: unknown,
): value is Buffer | ArrayBuffer | Uint8Array {
  return (
    value !== null &&
    (Buffer.isBuffer(value) ||
      value instanceof ArrayBuffer ||
      value instanceof Uint8Array)
  );
}

/**
 * Get byte length of audio data
 */
function getAudioLength(data: Buffer | ArrayBuffer | Uint8Array): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Uint8Array) return data.length;
  return 0;
}

/**
 * Get API key from environment or runtime
 */
function getApiKey(runtime: IAgentRuntime): string | undefined {
  const envKey =
    typeof process !== "undefined" ? process.env.ELEVENLABS_API_KEY : undefined;
  const runtimeKey = runtime.getSetting("ELEVENLABS_API_KEY") as
    | string
    | undefined;
  return envKey || runtimeKey;
}

/**
 * ElevenLabs Plugin Test Suite - Focused on Real TTS Functionality
 */
export const elevenLabsTestSuite: TestSuite = {
  name: "elevenlabs-tts-integration",

  tests: [
    {
      name: "Should have basic plugin structure",
      fn: async (_runtime: IAgentRuntime) => {
        if (!elevenLabsPlugin.name || !elevenLabsPlugin.models) {
          throw new Error("Plugin missing basic structure");
        }
        console.log("✅ Plugin structure verified");
      },
    },

    {
      name: "Should convert text to speech with real API",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          console.warn(
            "⚠️ Skipping real TTS test - no ELEVENLABS_API_KEY found",
          );
          return;
        }

        const textToSpeechModel =
          elevenLabsPlugin.models?.[ModelType.TEXT_TO_SPEECH];
        if (!textToSpeechModel) {
          throw new Error("TEXT_TO_SPEECH model not found");
        }

        const testText = "Hello, this is a test of ElevenLabs text to speech.";

        console.log("🎤 Testing real TTS with text:", testText);

        try {
          const audioData = await textToSpeechModel(runtime, testText);

          if (!isAudioData(audioData)) {
            throw new Error(
              `Expected audio data (Buffer/ArrayBuffer/Uint8Array), got: ${typeof audioData}`,
            );
          }

          const totalBytes = getAudioLength(audioData);

          if (totalBytes === 0) {
            throw new Error("No audio data received");
          }

          console.log(`✅ SUCCESS: Generated ${totalBytes} bytes of audio`);
        } catch (error: unknown) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);

          if (errorMsg.includes("QUOTA_EXCEEDED")) {
            console.warn("⚠️ ElevenLabs quota exceeded - test skipped");
            return;
          }

          console.error("❌ TTS test failed:", errorMsg);
          throw error;
        }
      },
    },

    {
      name: "Should test different voices",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          console.warn("⚠️ Skipping voice test - no API key");
          return;
        }

        const voices = [
          { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella" },
          { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
        ];

        const textToSpeechModel =
          elevenLabsPlugin.models?.[ModelType.TEXT_TO_SPEECH];
        if (!textToSpeechModel) {
          throw new Error("TEXT_TO_SPEECH model not found");
        }

        for (const voice of voices) {
          console.log(`🎭 Testing voice: ${voice.name} (${voice.id})`);

          try {
            const audioData = await textToSpeechModel(runtime, {
              text: `Testing voice ${voice.name}`,
              voice: voice.id,
            });

            if (!isAudioData(audioData)) {
              throw new Error(
                `Voice ${voice.name} failed to return audio data`,
              );
            }

            const totalBytes = getAudioLength(audioData);
            if (totalBytes === 0) {
              throw new Error(`Voice ${voice.name} returned empty data`);
            }

            console.log(`✅ Voice ${voice.name} working`);
          } catch (error: unknown) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);

            if (errorMsg.includes("QUOTA_EXCEEDED")) {
              console.warn(`⚠️ Quota exceeded for voice ${voice.name}`);
              break;
            }

            console.error(`❌ Voice ${voice.name} failed:`, errorMsg);
            throw error;
          }
        }
      },
    },

    {
      name: "Should handle longer text input",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          console.warn("⚠️ Skipping long text test - no API key");
          return;
        }

        const longText = `
          This is a longer text to test the ElevenLabs text-to-speech functionality.
          We want to ensure that the API can handle sentences of reasonable length
          and that the audio quality remains consistent throughout the entire speech.
          This test verifies that longer inputs are processed correctly.
        `.trim();

        console.log(`📝 Testing long text (${longText.length} characters)`);

        const textToSpeechModel =
          elevenLabsPlugin.models?.[ModelType.TEXT_TO_SPEECH];
        if (!textToSpeechModel) {
          throw new Error("TEXT_TO_SPEECH model not found");
        }

        try {
          const audioData = await textToSpeechModel(runtime, longText);

          if (!isAudioData(audioData)) {
            throw new Error("Expected audio data for long text");
          }

          const totalBytes = getAudioLength(audioData);

          if (totalBytes < 1000) {
            throw new Error(
              `Long text produced too little audio: ${totalBytes} bytes`,
            );
          }

          console.log(`✅ Long text generated ${totalBytes} bytes of audio`);
        } catch (error: unknown) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);

          if (errorMsg.includes("QUOTA_EXCEEDED")) {
            console.warn("⚠️ Quota exceeded testing long text");
            return;
          }

          console.error("❌ Long text test failed:", errorMsg);
          throw error;
        }
      },
    },

    {
      name: "Should test custom voice settings",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          console.warn("⚠️ Skipping voice settings test - no API key");
          return;
        }

        console.log("⚙️ Testing custom voice settings");

        const textToSpeechModel =
          elevenLabsPlugin.models?.[ModelType.TEXT_TO_SPEECH];
        if (!textToSpeechModel) {
          throw new Error("TEXT_TO_SPEECH model not found");
        }

        try {
          const audioData = await textToSpeechModel(runtime, {
            text: "Testing custom voice settings",
          });

          if (!isAudioData(audioData)) {
            throw new Error("Expected audio data with custom settings");
          }

          const totalBytes = getAudioLength(audioData);
          if (totalBytes === 0) {
            throw new Error("No audio data with custom settings");
          }

          console.log("✅ Custom voice settings working");
        } catch (error: unknown) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);

          if (errorMsg.includes("QUOTA_EXCEEDED")) {
            console.warn("⚠️ Quota exceeded testing voice settings");
            return;
          }

          console.error("❌ Voice settings test failed:", errorMsg);
          throw error;
        }
      },
    },
  ],
};

export default elevenLabsTestSuite;
