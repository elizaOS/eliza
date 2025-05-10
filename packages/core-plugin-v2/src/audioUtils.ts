import {
  getWavHeader as coreGetWavHeader,
  prependWavHeader as corePrependWavHeader,
} from '@elizaos/core';

/**
 * Generates a WAV file header based on the provided audio parameters.
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio.
 * @param {number} [channelCount=1] - The number of channels (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per sample (default is 16).
 * @returns {Buffer} The WAV file header as a Buffer object.
 */
function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Buffer {
  return coreGetWavHeader(audioLength, sampleRate, channelCount, bitsPerSample);
}

/**
 * Prepends a WAV header to a readable stream of audio data.
 *
 * @param {Readable} readable - The readable stream containing the audio data.
 * @param {number} audioLength - The length of the audio data in seconds.
 * @param {number} sampleRate - The sample rate of the audio data.
 * @param {number} [channelCount=1] - The number of channels in the audio data (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per sample in the audio data (default is 16).
 * @returns {Readable} A new readable stream with the WAV header prepended to the audio data.
 */
function prependWavHeader(
  readable: typeof Readable,
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): typeof Readable {
  return corePrependWavHeader(readable, audioLength, sampleRate, channelCount, bitsPerSample);
}

export { getWavHeader, prependWavHeader };
