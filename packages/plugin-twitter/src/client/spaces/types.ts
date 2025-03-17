// src/types.ts

import type { Space } from './core/Space';
import type { SpaceParticipant } from './core/SpaceParticipant';

/**
 * Basic PCM audio frame properties.
 */
/**
 * Represents audio data with specified characteristics.
 * @typedef {Object} AudioData
 * @property {number} bitsPerSample - Bits per sample (e.g., 16).
 * @property {number} sampleRate - The sample rate in Hz (e.g., 48000 for 48kHz).
 * @property {number} channelCount - Number of channels (e.g., 1 for mono, 2 for stereo).
 * @property {number} numberOfFrames - Number of frames (samples per channel).
 * @property {Int16Array} samples - The raw PCM data for all channels (interleaved if stereo).
 */
export interface AudioData {
  /**
   * Bits per sample (e.g., 16).
   */
  bitsPerSample: number;

  /**
   * The sample rate in Hz (e.g., 48000 for 48kHz).
   */
  sampleRate: number;

  /**
   * Number of channels (e.g., 1 for mono, 2 for stereo).
   */
  channelCount: number;

  /**
   * Number of frames (samples per channel).
   */
  numberOfFrames: number;

  /**
   * The raw PCM data for all channels (interleaved if stereo).
   */
  samples: Int16Array;
}

/**
 * PCM audio data with an associated user ID, indicating which speaker produced it.
 */
export interface AudioDataWithUser extends AudioData {
  /**
   * The ID of the speaker or user who produced this audio frame.
   */
  userId: string;
}

/**
 * Information about a speaker request event in a Space.
 */
export interface SpeakerRequest {
  userId: string;
  username: string;
  displayName: string;
  sessionUUID: string;
}

/**
 * Occupancy update describing the number of participants in a Space.
 */
export interface OccupancyUpdate {
  occupancy: number;
  totalParticipants: number;
}

/**
 * Represents an emoji reaction event by a user in the chat.
 */
export interface GuestReaction {
  displayName: string;
  emoji: string;
}

/**
 * Response structure after creating a broadcast on Periscope/Twitter.
 */
export interface BroadcastCreated {
  room_id: string;
  credential: string;
  stream_name: string;
  webrtc_gw_url: string;
  broadcast: {
    user_id: string;
    twitter_id: string;
    media_key: string;
  };
  access_token: string;
  endpoint: string;
  share_url: string;
  stream_url: string;
}

/**
 * Describes TURN server credentials and URIs.
 */
export interface TurnServersInfo {
  ttl: string;
  username: string;
  password: string;
  uris: string[];
}

/**
 * Defines a plugin interface for both Space (broadcast host) and SpaceParticipant (listener/speaker).
 *
 * Lifecycle hooks:
 *  - onAttach(...) is called immediately after .use(plugin).
 *  - init(...) is called after the space or participant has joined in basic mode (listener + chat).
 *  - onJanusReady(...) is called if/when a JanusClient is created (i.e., speaker mode).
 *  - onAudioData(...) is called upon receiving raw PCM frames from a speaker.
 *  - cleanup(...) is called when the space/participant stops or the plugin is removed.
 */
export interface Plugin {
  /**
   * Called immediately when the plugin is added via .use(plugin).
   * Usually used for initial references or minimal setup.
   */
  onAttach?(params: { space: Space | SpaceParticipant; pluginConfig?: Record<string, any> }): void;

  /**
   * Called once the space/participant has fully initialized basic features (chat, HLS, etc.).
   * This is the ideal place to finalize setup for plugins that do not require Janus/speaker mode.
   */
  init?(params: { space: Space | SpaceParticipant; pluginConfig?: Record<string, any> }): void;

  /**
   * Called if/when a JanusClient becomes available (e.g., user becomes a speaker).
   * Plugins that need direct Janus interactions can implement logic here.
   */
  onJanusReady?(janusClient: any): void;

  /**
   * Called whenever raw PCM audio frames arrive from a speaker.
   * Useful for speech-to-text, analytics, or logging.
   */
  onAudioData?(data: AudioDataWithUser): void;

  /**
   * Cleanup lifecycle hook, invoked when the plugin is removed or the space/participant stops.
   * Allows releasing resources, stopping timers, or closing file handles.
   */
  cleanup?(): void;
}

/**
 * Internal registration structure for a plugin, used to store the plugin instance + config.
 */
export interface PluginRegistration {
  plugin: Plugin;
  config?: Record<string, any>;
}

/**
 * Stores information about a speaker in a Space (host perspective).
 */
export interface SpeakerInfo {
  userId: string;
  sessionUUID: string;
  janusParticipantId?: number;
}

export interface SpaceConfig {
  mode: 'BROADCAST' | 'LISTEN' | 'INTERACTIVE';
  title?: string;
  description?: string;
  languages?: string[];
  debug?: boolean;
  record: boolean;
}
