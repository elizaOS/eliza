import {
  type IAgentRuntime,
  ModelType,
  type Plugin,
  logger,
  prependWavHeader,
  parseBooleanFromText,
} from '@elizaos/core';
import { Readable } from 'node:stream';

/**
 * Function to retrieve voice settings based on runtime and environment variables.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @returns {Object} - Object containing various voice settings.
 */
function getVoiceSettings(runtime: IAgentRuntime) {
  const getSetting = (key: string, fallback = '') =>
    process.env[key] || runtime.getSetting(key) || fallback;

  return {
    apiKey: getSetting('ELEVENLABS_API_KEY') || getSetting('ELEVENLABS_XI_API_KEY'),
    voiceId: getSetting('ELEVENLABS_VOICE_ID', 'EXAVITQu4vr4xnSDxMaL'),
    model: getSetting('ELEVENLABS_MODEL_ID', 'eleven_monolingual_v1'),
    stability: getSetting('ELEVENLABS_VOICE_STABILITY', '0.5'),
    latency: getSetting('ELEVENLABS_OPTIMIZE_STREAMING_LATENCY', '0'),
    outputFormat: getSetting('ELEVENLABS_OUTPUT_FORMAT', 'pcm_16000'),
    similarity: getSetting('ELEVENLABS_VOICE_SIMILARITY_BOOST', '0.75'),
    style: getSetting('ELEVENLABS_VOICE_STYLE', '0'),
    speakerBoost: parseBooleanFromText(getSetting('ELEVENLABS_VOICE_USE_SPEAKER_BOOST', 'true')),
  };
}

/**
 * Fetch speech from Eleven Labs API using given text and runtime settings.
 * @param {IAgentRuntime} runtime - The runtime interface containing necessary data for the API call.
 * @param {string} text - The text to be converted into speech.
 * @returns {Promise<Readable>} A promise resolving to a readable stream of the fetched speech.
 */
async function fetchSpeech(runtime: IAgentRuntime, text: string) {
  const settings = getVoiceSettings(runtime);
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${settings.voiceId}/stream?optimize_streaming_latency=${settings.latency}&output_format=${settings.outputFormat}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': settings.apiKey,
        },
        body: JSON.stringify({
          model_id: settings.model,
          text,
          voice_settings: {
            similarity_boost: settings.similarity,
            stability: settings.stability,
            style: settings.style,
            use_speaker_boost: settings.speakerBoost,
          },
        }),
      }
    );
    if (response.status !== 200) {
      const errorBodyString = await response.text();
      const errorBody = JSON.parse(errorBodyString);

      if (response.status === 401 && errorBody.detail?.status === 'quota_exceeded') {
        logger.log('ElevenLabs quota exceeded');
        throw new Error('QUOTA_EXCEEDED');
      }
      throw new Error(
        `Received status ${response.status} from Eleven Labs API: ${JSON.stringify(errorBody)}`
      );
    }
    return Readable.fromWeb(response.body);
  } catch (error) {
    throw new Error(error);
  }
}

/**
 * Represents the ElevenLabs plugin.
 * This plugin provides functionality related to ElevenLabs API, including text to speech conversion.
 * @type {Plugin}
 */
export const elevenLabsPlugin: Plugin = {
  name: 'elevenLabs',
  description: 'ElevenLabs plugin',
  models: {
    [ModelType.TEXT_TO_SPEECH]: async (runtime, text) => {
      try {
        const stream = await fetchSpeech(runtime, text);
        return getVoiceSettings(runtime).outputFormat.startsWith('pcm_')
          ? prependWavHeader(
              stream,
              1024 * 1024 * 100,
              Number.parseInt(getVoiceSettings(runtime).outputFormat.slice(4)),
              1,
              16
            )
          : stream;
      } catch (error) {
        throw new Error(
          `Failed to fetch speech from Eleven Labs API: ${error.message || 'Unknown error occurred'}`
        );
      }
    },
  },
  tests: [
    {
      name: 'test eleven labs',
      tests: [
        {
          name: 'Eleven Labs API key validation',
          fn: async (runtime: IAgentRuntime) => {
            if (!getVoiceSettings(runtime).apiKey) {
              throw new Error('Missing API key: Please provide a valid Eleven Labs API key.');
            }
          },
        },
        {
          name: 'Eleven Labs API response',
          fn: async (runtime: IAgentRuntime) => {
            try {
              await fetchSpeech(runtime, 'test');
            } catch (error) {
              throw new Error(
                `Failed to fetch speech from Eleven Labs API: ${error.message || 'Unknown error occurred'}`
              );
            }
          },
        },
      ],
    },
  ],
};
export default elevenLabsPlugin;
