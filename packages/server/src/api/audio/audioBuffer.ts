import { Readable } from 'node:stream';

/**
 * Determines the appropriate MIME type for audio data based on its format.
 * Detects WAV files by checking for the RIFF header signature.
 *
 * @param audioBuffer - The audio data buffer to check
 * @returns The appropriate MIME type string
 */
export function getAudioMimeType(audioBuffer: Buffer): string {
  // Check if this is a WAV file by looking for the RIFF header
  // WAV files start with the signature "RIFF" followed by file size,
  // then "WAVE" identifier
  if (
    audioBuffer.length >= 12 &&
    audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    audioBuffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'audio/wav';
  }

  // MP3 files typically start with ID3 tag or directly with an MP3 frame
  // Check for ID3 tag (ID3v2)
  if (audioBuffer.length >= 3 && audioBuffer.toString('ascii', 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }

  // Check for MP3 frame header (begins with 0xFF followed by 0xE or 0xF)
  if (audioBuffer.length >= 2 && audioBuffer[0] === 0xff && (audioBuffer[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }

  // Default to MP3 if we can't determine (maintaining backward compatibility)
  return 'audio/mpeg';
}

/**
 * Result of audio processing containing the buffer and MIME type
 */
export interface AudioProcessingResult {
  buffer: Buffer;
  mimeType: string;
}

export async function convertToAudioBuffer(speechResponse: any): Promise<Buffer>;
export async function convertToAudioBuffer(
  speechResponse: any,
  detectMimeType: true
): Promise<AudioProcessingResult>;
export async function convertToAudioBuffer(
  speechResponse: any,
  detectMimeType?: boolean
): Promise<Buffer | AudioProcessingResult> {
  let resultBuffer: Buffer;

  if (Buffer.isBuffer(speechResponse)) {
    resultBuffer = speechResponse;
  } else if (typeof speechResponse?.getReader === 'function') {
    // Handle Web ReadableStream
    const reader = (speechResponse as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      resultBuffer = Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  } else if (
    speechResponse instanceof Readable ||
    (speechResponse &&
      speechResponse.readable === true &&
      typeof speechResponse.pipe === 'function' &&
      typeof speechResponse.on === 'function')
  ) {
    // Handle Node Readable Stream
    resultBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      speechResponse.on('data', (chunk: any) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      );
      speechResponse.on('end', () => resolve(Buffer.concat(chunks)));
      speechResponse.on('error', (err: Error) => reject(err));
    });
  } else {
    throw new Error('Unexpected response type from TEXT_TO_SPEECH model');
  }

  // Return both buffer and MIME type if requested
  if (detectMimeType) {
    return {
      buffer: resultBuffer,
      mimeType: getAudioMimeType(resultBuffer),
    };
  }

  // Otherwise just return the buffer for backward compatibility
  return resultBuffer;
}
