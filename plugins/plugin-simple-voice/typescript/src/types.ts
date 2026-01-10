/**
 * SAM TTS Voice Configuration
 *
 * Parameters for controlling the SAM speech synthesizer output.
 */
export interface SamTTSOptions {
  /** Speaking speed (20-200) */
  speed: number;
  /** Voice pitch (0-255) */
  pitch: number;
  /** Throat resonance (0-255) */
  throat: number;
  /** Mouth articulation (0-255) */
  mouth: number;
}

/**
 * Default SAM voice settings
 */
export const DEFAULT_SAM_OPTIONS: SamTTSOptions = {
  speed: 72,
  pitch: 64,
  throat: 128,
  mouth: 128,
};

/**
 * Service type registry extension for SAM TTS
 */
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    SAM_TTS: 'SAM_TTS';
  }
}

/**
 * SAM service type constant
 */
export const SAMServiceType = {
  SAM_TTS: 'SAM_TTS' as const,
} satisfies Partial<import('@elizaos/core').ServiceTypeRegistry>;

/**
 * Hardware bridge service interface for audio output
 */
export interface HardwareBridgeService {
  sendAudioData(audioBuffer: Uint8Array): Promise<void>;
}

/**
 * Speech trigger phrases that activate the SAY_ALOUD action
 */
export const SPEECH_TRIGGERS = [
  'say aloud',
  'speak',
  'read aloud',
  'say out loud',
  'voice',
  'speak this',
  'say this',
  'read this',
  'announce',
  'proclaim',
  'tell everyone',
  'speak up',
  'use your voice',
  'talk to me',
  'higher voice',
  'lower voice',
  'change voice',
  'robotic voice',
  'retro voice',
] as const;

/**
 * Vocalization intent patterns
 */
export const VOCALIZATION_PATTERNS = [
  'can you say',
  'please say',
  'i want to hear',
  'let me hear',
] as const;
