import { PassThrough, type Readable } from 'node:stream';

/**
 * Generates a WAV header for audio data based on the input parameters.
 *
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio data.
 * @param {number} [channelCount=1] - The number of audio channels (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per audio sample (default is 16).
 * @returns {Buffer} - The WAV header as a Buffer.
 */
export function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // Length of format data
  wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
  wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
  wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28); // Byte rate
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align
  wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
  wavHeader.write('data', 36); // Data chunk header
  wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
  return wavHeader;
}

/**
 * Prepends a WAV header to an audio stream.
 *
 * @param {Readable} readable - The readable stream of audio data.
 * @param {number} audioLength - The length of the audio in seconds.
 * @param {number} sampleRate - The sample rate of the audio.
 * @param {number} [channelCount=1] - The number of audio channels. Default is 1.
 * @param {number} [bitsPerSample=16] - The number of bits per sample. Default is 16.
 * @returns {Readable} - A readable stream with the WAV header prepended to the audio data.
 */
export function prependWavHeader(
  readable: Readable,
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Readable {
  const wavHeader = getWavHeader(audioLength, sampleRate, channelCount, bitsPerSample);
  let pushedHeader = false;
  const passThrough = new PassThrough();
  readable.on('data', (data) => {
    if (!pushedHeader) {
      passThrough.push(wavHeader);
      pushedHeader = true;
    }
    passThrough.push(data);
  });
  readable.on('end', () => {
    passThrough.end();
  });
  return passThrough;
}
