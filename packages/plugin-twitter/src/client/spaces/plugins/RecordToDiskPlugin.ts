import * as fs from 'node:fs';
import type { Space } from '../core/Space';
import type { SpaceParticipant } from '../core/SpaceParticipant';
import { Logger } from '../logger';
import type { AudioDataWithUser, Plugin } from '../types';

/**
 * Configuration options for the RecordToDiskPlugin.
 *
 * @typedef {Object} RecordToDiskPluginConfig
 * @property {string} [filePath] - The file path where records will be stored.
 * @property {boolean} [debug] - Whether to enable verbose logs.
 */
interface RecordToDiskPluginConfig {
  filePath?: string;
  debug?: boolean; // whether to enable verbose logs
}

/**
 * RecordToDiskPlugin
 * ------------------
 * A simple plugin that writes all incoming PCM frames to a local .raw file.
 *
 * Lifecycle:
 *  - onAttach(...) => minimal references, logger config
 *  - init(...) => finalize file path, open stream
 *  - onAudioData(...) => append PCM frames to the file
 *  - cleanup(...) => close file stream
 */
/**
 * Class representing a plugin for recording audio data to disk.
 * @implements {Plugin}
 */
export class RecordToDiskPlugin implements Plugin {
  private filePath = '/tmp/speaker_audio.raw';
  private outStream?: fs.WriteStream;
  private logger?: Logger;

  /**
   * Called immediately after .use(plugin).
   * We create a logger based on pluginConfig.debug and store the file path if provided.
   */
  onAttach(params: { space: Space | SpaceParticipant; pluginConfig?: Record<string, any> }): void {
    const debugEnabled = params.pluginConfig?.debug ?? false;
    this.logger = new Logger(debugEnabled);

    this.logger.info('[RecordToDiskPlugin] onAttach => plugin attached');

    if (params.pluginConfig?.filePath) {
      this.filePath = params.pluginConfig.filePath;
    }
    this.logger.debug('[RecordToDiskPlugin] Using filePath =>', this.filePath);
  }

  /**
   * Called after the space/participant has joined in basic mode.
   * We open the WriteStream to our file path here.
   */
  init(params: { space: Space | SpaceParticipant; pluginConfig?: Record<string, any> }): void {
    // If filePath was re-defined in pluginConfig, re-check:
    if (params.pluginConfig?.filePath) {
      this.filePath = params.pluginConfig.filePath;
    }

    this.logger?.info('[RecordToDiskPlugin] init => opening output stream');
    this.outStream = fs.createWriteStream(this.filePath, { flags: 'w' });
  }

  /**
   * Called whenever PCM audio frames arrive from a speaker.
   * We write them to the file as raw 16-bit PCM.
   */
  onAudioData(data: AudioDataWithUser): void {
    if (!this.outStream) {
      this.logger?.warn('[RecordToDiskPlugin] No outStream yet; ignoring data');
      return;
    }
    const buf = Buffer.from(data.samples.buffer);
    this.outStream.write(buf);
    this.logger?.debug(
      `[RecordToDiskPlugin] Wrote ${buf.byteLength} bytes from userId=${data.userId} to disk`
    );
  }

  /**
   * Called when the plugin is cleaned up (e.g. space/participant stop).
   * We close our file stream.
   */
  cleanup(): void {
    this.logger?.info('[RecordToDiskPlugin] cleanup => closing output stream');
    if (this.outStream) {
      this.outStream.end();
      this.outStream = undefined;
    }
  }
}
